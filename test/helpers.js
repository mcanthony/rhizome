var assert = require('assert')
  , querystring = require('querystring')
  , fs = require('fs')
  , _ = require('underscore')
  , async = require('async')
  , WebSocket = require('ws')
  , moscow = require('moscow')
  , oscMin = require('osc-min')
  , oscServer = require('../lib/osc/Server')
  , connections = require('../lib/connections')
  , coreServer = require('../lib/core/server')
  , coreMessages = require('../lib/core/messages')
  , ValidationError = require('../lib/core/errors').ValidationError
  , utils = require('../lib/core/utils')

// For testing : we need to add standard `removeEventListener` method cause `ws` doesn't implement it.
WebSocket.prototype.removeEventListener = function(name, cb) {
  var self = this
    , handlerList = this._events[name]
  handlerList = _.isFunction(handlerList) ? [handlerList] : handlerList
  this._events[name] = _.reject(handlerList, function(other) {
    return other._listener === cb
  })
}

// Helper to create dummy web clients
exports.dummyWebClients = function(wsServer, clients, done) {
  var countBefore = wsServer._wsServer.clients.length 
    , url
  async.series(clients.map(function(client) {
    return function(next) {
      _.defaults(client, { query: {} })
      client.query.dummies = ''
      url = 'ws://localhost:' + client.port + '/?' + querystring.stringify(client.query)
      socket = new WebSocket(url)
      _dummyWebClients.push(socket)
      
      socket.on('open', function() {
        socket.once('message', function(msg) {
          msg = oscMin.fromBuffer(msg)
          var args = _.pluck(msg.args, 'value')
          if (msg.address === coreMessages.connectionStatusAddress) next(null, args)
          else throw new Error('unexpected message ' + msg.address + ' ' + msg.args.join(', '))
        })
      })
    }
  }), function(err, messages) {
    if (done) done(err, _dummyWebClients, messages)
  })
}
var _dummyWebClients = []

// Helper to create dummy osc clients
exports.dummyOSCClients = function(expectedMsgCount, clients, handler) {
  var answerReceived = waitForAnswers(expectedMsgCount, function() {
    var _arguments = arguments
    async.series(servers.map(function(server) {
      return server.stop.bind(server)
    }), function(err) {
      if (err) throw err 
      handler.apply(this, _arguments)
    })
  })

  var servers = clients.map(function(client, i) {
    var server = new moscow.createServer(client.appPort, client.transport || 'udp')
    server.start(function(err) { if (err) throw err })
    server.on('message', function(address, args) {
      answerReceived(client.appPort, address, args)
    })
    return server
  })
  return servers
}

// Helpers to create dummy server-side connections
var DummyConnection = exports.DummyConnection = function(callback) {
  this.callback = callback
  coreServer.Connection.apply(this)
}
_.extend(DummyConnection.prototype, coreServer.Connection.prototype, {
  namespace: 'dummy',
  send: function(address, args) { this.callback(address, args) },
  serialize: function() { return this.testData || {} },
  deserialize: function(data) { this.restoredTestData = data }
})

exports.dummyConnections = function(expectedMsgCount, connectionCount, handler) {
  var answerReceived = waitForAnswers(expectedMsgCount, handler)
  return _.range(connectionCount).map(function(i) {
    return new DummyConnection(answerReceived.bind(this, i))
  })
}

// Helper for asynchronous tests, waiting for `expectedCount` answers and then calling `done`
var waitForAnswers = exports.waitForAnswers = function(expectedCount, done) {
  var received = []
  return function () {
    received.push(_.toArray(arguments))
    if (received.length >= expectedCount) done(received)
  }
}

exports.beforeEach = function(manager, toStart, done) {
  var asyncOps = [
    function(next) {
      fs.exists('/tmp/connections.db', function(exists) {
        if (exists) fs.unlink('/tmp/connections.db', next) 
        else next()
      })
    },
    manager.start.bind(manager)
  ]
  connections.manager = manager

  if (arguments.length === 2) {
    done = toStart
    toStart = []
  }

  if (toStart.length) toStart.forEach(function(obj) { asyncOps.push(obj.start.bind(obj)) })

  async.series(asyncOps, done)
}

// Helper with common operations to clean after a test
exports.afterEach = function(toStop, done) {
  var asyncOps = []

  if (arguments.length === 1) {
    done = toStop
    toStop = []
  }

  _dummyWebClients.forEach(function(socket) { socket.close() })
  _dummyWebClients = []
  if (toStop.length) toStop.forEach(function(obj) { asyncOps.push(obj.stop.bind(obj)) })
  
  if (asyncOps.length) async.series(asyncOps, done)
  else done()
}

// Helper to assert that 2 arrays contain the same elements (using deepEqual)
exports.assertSameElements = function(arr1, arr2) {
  var sorted1 = _.sortBy(arr1, _sortFunc)
    , sorted2 = _.sortBy(arr2, _sortFunc)
  assert.deepEqual(sorted1, sorted2)
}
var _sortFunc = function(obj) {
  vals = obj
  if (_.isObject(obj)) {
    vals = _.chain(obj).pairs()
      .sortBy(function(p) { return p[0] })
      .pluck(1).value()
  }
  return vals.map(function(v) { return v === null ? 'null' : v.toString() }).join('')
}

var assertValidationError = exports.assertValidationError = function(err, expected) {
  if (!(err instanceof ValidationError)) throw new Error('Expected ValidationError, got :' + err)
  var actual = _.keys(err.fields)
  actual.sort()
  expected.sort()
  assert.deepEqual(actual, expected)
}

exports.assertConfigErrors = function(testList, done) {
  async.forEach(testList, function(p, next) {
    var obj = p[0]
      , expected = p[1]
    obj.start(function(err) {
      assertValidationError(err, expected)
      next()
    })
  }, done)
}