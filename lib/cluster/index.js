'use strict';

var Deque = require('denque');
var Redis = require('../redis');
var utils = require('../utils');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('../utils/debug')('ioredis:cluster');
var _ = require('../utils/lodash');
var ScanStream = require('../ScanStream').default;
var Commander = require('../commander');
var Command = require('../command');
var commands = require('redis-commands');
var asCallback = require('standard-as-callback');
var ConnectionPool = require('./ConnectionPool').default;
var ClusterSubscriber = require('./ClusterSubscriber').default;
var DelayQueue = require('./DelayQueue').default;
var PromiseContainer = require('../promiseContainer');
var {AbortError} = require('redis-errors');

/**
 * Creates a Redis Cluster instance
 *
 * @constructor
 * @param {Object[]} startupNodes - An array of nodes in the cluster, [{ port: number, host: string }]
 * @param {Object} options
 * @param {function} [options.clusterRetryStrategy] - See "Quick Start" section
 * @param {boolean} [options.enableOfflineQueue=true] - See Redis class
 * @param {boolean} [options.enableReadyCheck=true] - When enabled, ioredis only emits "ready" event when `CLUSTER INFO`
 * command reporting the cluster is ready for handling commands.
 * @param {string} [options.scaleReads=master] - Scale reads to the node with the specified role.
 * Available values are "master", "slave" and "all".
 * @param {number} [options.maxRedirections=16] - When a MOVED or ASK error is received, client will redirect the
 * command to another node. This option limits the max redirections allowed to send a command.
 * @param {number} [options.retryDelayOnFailover=100] - When an error is received when sending a command(e.g.
 * "Connection is closed." when the target Redis node is down),
 * @param {number} [options.retryDelayOnClusterDown=100] - When a CLUSTERDOWN error is received, client will retry
 * if `retryDelayOnClusterDown` is valid delay time.
 * @param {number} [options.retryDelayOnTryAgain=100] - When a TRYAGAIN error is received, client will retry
 * if `retryDelayOnTryAgain` is valid delay time.
 * @param {number} [options.slotsRefreshTimeout=1000] - The milliseconds before a timeout occurs while refreshing
 * slots from the cluster.
 * @param {number} [options.slotsRefreshInterval=5000] - The milliseconds between every automatic slots refresh.
 * @param {Object} [options.redisOptions] - Passed to the constructor of `Redis`.
 * @extends [EventEmitter](http://nodejs.org/api/events.html#events_class_events_eventemitter)
 * @extends Commander
 */
function Cluster(startupNodes, options) {
  EventEmitter.call(this);
  Commander.call(this);

  this.options = _.defaults(this.options, options, Cluster.defaultOptions);

  // validate options
  if (typeof this.options.scaleReads !== 'function' &&
      ['all', 'master', 'slave'].indexOf(this.options.scaleReads) === -1) {
    throw new Error('Invalid option scaleReads "' + this.options.scaleReads +
      '". Expected "all", "master", "slave" or a custom function');
  }

  this.connectionPool = new ConnectionPool(this.options.redisOptions);
  this.startupNodes = startupNodes;

  this.connectionPool.on('-node', (redis, key) => {
    this.emit('-node', redis);
  });
  this.connectionPool.on('+node', (redis) => {
    this.emit('+node', redis);
  });
  this.connectionPool.on('drain', () => {
    this.setStatus('close');
  });
  this.connectionPool.on('nodeError', (error) => {
    this.emit('node error', error);
  });

  this.slots = [];
  this.retryAttempts = 0;

  this.resetOfflineQueue();
  this.delayQueue = new DelayQueue();

  this.subscriber = new ClusterSubscriber(this.connectionPool, this)

  if (this.options.lazyConnect) {
    this.setStatus('wait');
  } else {
    this.connect().catch((err) => {
      debug('connecting failed: %s', err)
    });
  }
}

/**
 * Default options
 *
 * @var defaultOptions
 * @private
 */
Cluster.defaultOptions = {
  clusterRetryStrategy: function (times) {
    return Math.min(100 + times * 2, 2000);
  },
  enableOfflineQueue: true,
  enableReadyCheck: true,
  scaleReads: 'master',
  maxRedirections: 16,
  retryDelayOnFailover: 100,
  retryDelayOnClusterDown: 100,
  retryDelayOnTryAgain: 100,
  slotsRefreshTimeout: 1000,
  slotsRefreshInterval: 5000
};

util.inherits(Cluster, EventEmitter);
Object.assign(Cluster.prototype, Commander.prototype);

Cluster.prototype.resetOfflineQueue = function () {
  this.offlineQueue = new Deque();
};

Cluster.prototype.resetNodesRefreshInterval = function () {
  if (this.slotsTimer) {
    return;
  }
  this.slotsTimer = setInterval(function() {
    this.refreshSlotsCache();
  }.bind(this), this.options.slotsRefreshInterval);
};

/**
 * Connect to a cluster
 *
 * @return {Promise}
 * @public
 */
Cluster.prototype.connect = function () {
  var Promise = PromiseContainer.get();
  return new Promise(function (resolve, reject) {
    if (this.status === 'connecting' || this.status === 'connect' || this.status === 'ready') {
      reject(new Error('Redis is already connecting/connected'));
      return;
    }
    this.setStatus('connecting');

    if (!Array.isArray(this.startupNodes) || this.startupNodes.length === 0) {
      throw new Error('`startupNodes` should contain at least one node.');
    }

    this.connectionPool.reset(this.startupNodes);

    function readyHandler() {
      this.setStatus('ready');
      this.retryAttempts = 0;
      this.executeOfflineCommands();
      this.resetNodesRefreshInterval();
      resolve();
    }

    var closeListener;
    var refreshListener = function () {
      this.removeListener('close', closeListener);
      this.manuallyClosing = false;
      this.setStatus('connect');
      if (this.options.enableReadyCheck) {
        this._readyCheck(function (err, fail) {
          if (err || fail) {
            debug('Ready check failed (%s). Reconnecting...', err || fail);
            if (this.status === 'connect') {
              this.disconnect(true);
            }
          } else {
            readyHandler.call(this);
          }
        }.bind(this));
      } else {
        readyHandler.call(this);
      }
    };

    closeListener = function () {
      this.removeListener('refresh', refreshListener);
      reject(new Error('None of startup nodes is available'));
    };

    this.once('refresh', refreshListener);
    this.once('close', closeListener);
    this.once('close', this._handleCloseEvent.bind(this));

    this.refreshSlotsCache(function (err) {
      if (err && err.message === 'Failed to refresh slots cache.') {
        Redis.prototype.silentEmit.call(this, 'error', err);
        this.connectionPool.reset([]);
      }
    }.bind(this));
    this.subscriber.start();
  }.bind(this));
};

/**
 * Called when closed to check whether a reconnection should be made
 *
 * @private
 */
Cluster.prototype._handleCloseEvent = function () {
  var retryDelay;
  if (!this.manuallyClosing && typeof this.options.clusterRetryStrategy === 'function') {
    retryDelay = this.options.clusterRetryStrategy.call(this, ++this.retryAttempts);
  }
  if (typeof retryDelay === 'number') {
    this.setStatus('reconnecting');
    this.reconnectTimeout = setTimeout(function () {
      this.reconnectTimeout = null;
      debug('Cluster is disconnected. Retrying after %dms', retryDelay);
      this.connect().catch(function (err) {
        debug('Got error %s when reconnecting. Ignoring...', err);
      });
    }.bind(this), retryDelay);
  } else {
    this.setStatus('end');
    this.flushQueue(new Error('None of startup nodes is available'));
  }
};

/**
 * Disconnect from every node in the cluster.
 * @param {boolean} [reconnect]
 * @public
 */
Cluster.prototype.disconnect = function (reconnect) {
  var status = this.status;
  this.setStatus('disconnecting');

  if (!reconnect) {
    this.manuallyClosing = true;
  }
  if (this.reconnectTimeout) {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
    debug('Canceled reconnecting attempts');
  }
  if (this.slotsTimer) {
    clearInterval(this.slotsTimer);
    this.slotsTimer = null;
  }

  this.subscriber.stop();
  if (status === 'wait') {
    this.setStatus('close');
    this._handleCloseEvent();
  } else {
    this.connectionPool.reset([]);
  }
};

/**
 * Quit the cluster gracefully.
 *
 * @param {function} [callback]
 * @return {Promise} return 'OK' if successfully
 * @public
 */
Cluster.prototype.quit = function (callback) {
  var status = this.status;
  this.setStatus('disconnecting');

  this.manuallyClosing = true;

  if (this.reconnectTimeout) {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }
  if (this.slotsTimer) {
    clearInterval(this.slotsTimer);
    this.slotsTimer = null;
  }

  var Promise = PromiseContainer.get();
  if (status === 'wait') {
    var ret = asCallback(Promise.resolve('OK'), callback);

    // use setImmediate to make sure "close" event
    // being emitted after quit() is returned
    setImmediate(function () {
      this.setStatus('close');
      this._handleCloseEvent();
    }.bind(this));

    return ret;
  }
  return asCallback(
    Promise.all(this.nodes().map(function (node) {
      return node.quit();
    })).then(function () {
      return 'OK';
    }),
    callback
  );
};

/**
 * Get nodes with the specified role
 *
 * @param {string} [role=all] - role, "master", "slave" or "all"
 * @return {Redis[]} array of nodes
 * @public
 */
Cluster.prototype.nodes = function (role) {
  role = role || 'all';
  if (role !== 'all' && role !== 'master' && role !== 'slave') {
    throw new Error('Invalid role "' + role + '". Expected "all", "master" or "slave"');
  }
  return this.connectionPool.getNodes(role)
};

/**
 * Change cluster instance's status
 *
 * @param {string} status
 * @private
 */
Cluster.prototype.setStatus = function (status) {
  debug('status: %s -> %s', this.status || '[empty]', status);
  this.status = status;
  process.nextTick(this.emit.bind(this, status));
};

/**
 * Refresh the slot cache
 *
 * @param {function} [callback]
 * @private
 */
Cluster.prototype.refreshSlotsCache = function (callback) {
  if (this.isRefreshing) {
    if (typeof callback === 'function') {
      process.nextTick(callback);
    }
    return;
  }
  this.isRefreshing = true;

  var _this = this;
  var wrapper = function () {
    _this.isRefreshing = false;
    if (typeof callback === 'function') {
      callback.apply(null, arguments);
    }
  };

  var keys = utils.shuffle(Object.keys(this.connectionPool.nodes.all));

  var lastNodeError = null;

  function tryNode(index) {
    if (index === keys.length) {
      var error = new Error('Failed to refresh slots cache.');
      error.lastNodeError = lastNodeError;
      return wrapper(error);
    }
    debug('getting slot cache from %s', keys[index]);
    _this.getInfoFromNode(_this.connectionPool.nodes.all[keys[index]], function (err) {
      if (_this.status === 'end') {
        return wrapper(new Error('Cluster is disconnected.'));
      }
      if (err) {
        _this.emit('node error', err);
        lastNodeError = err;
        tryNode(index + 1);
      } else {
        _this.emit('refresh');
        wrapper();
      }
    });
  }

  tryNode(0);
};

/**
 * Flush offline queue with error.
 *
 * @param {Error} error - The error object to send to the commands
 * @private
 */
Cluster.prototype.flushQueue = function (error) {
  var item;
  while (this.offlineQueue.length > 0) {
    item = this.offlineQueue.shift();
    item.command.reject(error);
  }
};

Cluster.prototype.executeOfflineCommands = function () {
  if (this.offlineQueue.length) {
    debug('send %d commands in offline queue', this.offlineQueue.length);
    var offlineQueue = this.offlineQueue;
    this.resetOfflineQueue();
    while (offlineQueue.length > 0) {
      var item = offlineQueue.shift();
      this.sendCommand(item.command, item.stream, item.node);
    }
  }
};

Cluster.prototype.sendCommand = function (command, stream, node) {
  if (this.status === 'wait') {
    this.connect().catch(_.noop);
  }
  if (this.status === 'end') {
    command.reject(new Error(utils.CONNECTION_CLOSED_ERROR_MSG));
    return command.promise;
  }
  var to = this.options.scaleReads;
  if (to !== 'master') {
    var isCommandReadOnly = commands.exists(command.name) && commands.hasFlag(command.name, 'readonly');
    if (!isCommandReadOnly) {
      to = 'master';
    }
  }

  var targetSlot = node ? node.slot : command.getSlot();
  var ttl = {};
  var _this = this;
  if (!node && !command.__is_reject_overwritten) {
    command.__is_reject_overwritten = true;
    var reject = command.reject;
    command.reject = function (err) {
      var partialTry = tryConnection.bind(null, true)
      _this.handleError(err, ttl, {
        moved: function (slot, key) {
          debug('command %s is moved to %s', command.name, key);
          if (_this.slots[slot]) {
            _this.slots[slot][0] = key;
          } else {
            _this.slots[slot] = [key];
          }
          var splitKey = key.split(':');
          _this.connectionPool.findOrCreate({ host: splitKey[0], port: Number(splitKey[1]) });
          tryConnection();
          _this.refreshSlotsCache();
        },
        ask: function (slot, key) {
          debug('command %s is required to ask %s:%s', command.name, key);
          var splitKey = key.split(':');
          _this.connectionPool.findOrCreate({ host: splitKey[0], port: Number(splitKey[1]) });
          tryConnection(false, key);
        },
        tryagain: partialTry,
        clusterDown: partialTry,
        connectionClosed: partialTry,
        maxRedirections: function (redirectionError) {
          reject.call(command, redirectionError);
        },
        defaults: function () {
          reject.call(command, err);
        }
      });
    };
  }
  tryConnection();

  function tryConnection(random, asking) {
    if (_this.status === 'end') {
      command.reject(new AbortError('Cluster is ended.'));
      return;
    }
    var redis;
    if (_this.status === 'ready' || (command.name === 'cluster')) {
      if (node && node.redis) {
        redis = node.redis;
      } else if (Command.checkFlag('ENTER_SUBSCRIBER_MODE', command.name) ||
                 Command.checkFlag('EXIT_SUBSCRIBER_MODE', command.name)) {
        redis = _this.subscriber.getInstance();
        if (!redis) {
          command.reject(new AbortError('No subscriber for the cluster'));
          return;
        }
      } else {
        if (!random) {
          if (typeof targetSlot === 'number' && _this.slots[targetSlot]) {
            var nodeKeys = _this.slots[targetSlot];
            if (typeof to === 'function') {
              var nodes =
                  nodeKeys
                    .map(function (key) {
                      return _this.connectionPool.nodes.all[key];
                    });
              redis = to(nodes, command);
              if (Array.isArray(redis)) {
                redis = utils.sample(redis);
              }
              if (!redis) {
                redis = nodes[0];
              }
            } else {
              var key;
              if (to === 'all') {
                key = utils.sample(nodeKeys);
              } else if (to === 'slave' && nodeKeys.length > 1) {
                key = utils.sample(nodeKeys, 1);
              } else {
                key = nodeKeys[0];
              }
              redis = _this.connectionPool.nodes.all[key];
            }
          }
          if (asking) {
            redis = _this.connectionPool.nodes.all[asking];
            redis.asking();
          }
        }
        if (!redis) {
          redis = utils.sample(_this.connectionPool.getNodes(to)) ||
            utils.sample(_this.connectionPool.getNodes('all'));
        }
      }
      if (node && !node.redis) {
        node.redis = redis;
      }
    }
    if (redis) {
      redis.sendCommand(command, stream);
    } else if (_this.options.enableOfflineQueue) {
      _this.offlineQueue.push({
        command: command,
        stream: stream,
        node: node
      });
    } else {
      command.reject(new Error('Cluster isn\'t ready and enableOfflineQueue options is false'));
    }
  }
  return command.promise;
};

Cluster.prototype.handleError = function (error, ttl, handlers) {
  if (typeof ttl.value === 'undefined') {
    ttl.value = this.options.maxRedirections;
  } else {
    ttl.value -= 1;
  }
  if (ttl.value <= 0) {
    handlers.maxRedirections(new Error('Too many Cluster redirections. Last error: ' + error));
    return;
  }
  var errv = error.message.split(' ');
  if (errv[0] === 'MOVED' || errv[0] === 'ASK') {
    handlers[errv[0] === 'MOVED' ? 'moved' : 'ask'](errv[1], errv[2]);
  } else if (errv[0] === 'TRYAGAIN') {
    this.delayQueue.push('tryagain', handlers.tryagain, {
      timeout: this.options.retryDelayOnTryAgain
    });
  } else if (errv[0] === 'CLUSTERDOWN' && this.options.retryDelayOnClusterDown > 0) {
    this.delayQueue.push('clusterdown', handlers.connectionClosed, {
      timeout: this.options.retryDelayOnClusterDown,
      callback: this.refreshSlotsCache.bind(this)
    });
  } else if (
    error.message === utils.CONNECTION_CLOSED_ERROR_MSG &&
    this.options.retryDelayOnFailover > 0 &&
    this.status === 'ready'
  ) {
    this.delayQueue.push('failover', handlers.connectionClosed, {
      timeout: this.options.retryDelayOnFailover,
      callback: this.refreshSlotsCache.bind(this)
    });
  } else {
    handlers.defaults();
  }
};

Cluster.prototype.getInfoFromNode = function (redis, callback) {
  if (!redis) {
    return callback(new Error('Node is disconnected'));
  }
  redis.cluster('slots', utils.timeout((err, result) => {
    if (err) {
      redis.disconnect();
      return callback(err);
    }
    var nodes = [];

    debug('cluster slots result count: %d', result.length)

    for (var i = 0; i < result.length; ++i) {
      var items = result[i];
      var slotRangeStart = items[0];
      var slotRangeEnd = items[1];

      var keys = [];
      for (var j = 2; j < items.length; j++) {
        items[j] = { host: items[j][0], port: items[j][1] };
        items[j].readOnly = j !== 2;
        nodes.push(items[j]);
        keys.push(items[j].host + ':' + items[j].port);
      }

      debug('cluster slots result [%d]: slots %d~%d served by %s', i, slotRangeStart, slotRangeEnd, keys)

      for (var slot = slotRangeStart; slot <= slotRangeEnd; slot++) {
        this.slots[slot] = keys;
      }
    }

    this.connectionPool.reset(nodes);
    callback();
  }, this.options.slotsRefreshTimeout));
};

/**
 * Check whether Cluster is able to process commands
 *
 * @param {Function} callback
 * @private
 */
Cluster.prototype._readyCheck = function (callback) {
  this.cluster('info', function (err, res) {
    if (err) {
      return callback(err);
    }
    if (typeof res !== 'string') {
      return callback();
    }

    var state;
    var lines = res.split('\r\n');
    for (var i = 0; i < lines.length; ++i) {
      var parts = lines[i].split(':');
      if (parts[0] === 'cluster_state') {
        state = parts[1];
        break;
      }
    }

    if (state === 'fail') {
      debug('cluster state not ok (%s)', state);
      callback(null, state);
    } else {
      callback();
    }
  });
};

['sscan', 'hscan', 'zscan', 'sscanBuffer', 'hscanBuffer', 'zscanBuffer']
  .forEach(function (command) {
    Cluster.prototype[command + 'Stream'] = function (key, options) {
      return new ScanStream(_.defaults({
        objectMode: true,
        key: key,
        redis: this,
        command: command
      }, options));
    };
  });

require('../transaction').addTransactionSupport(Cluster.prototype);

module.exports = Cluster;
