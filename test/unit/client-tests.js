/*
 * Copyright DataStax, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';
const assert = require('chai').assert;
const util = require('util');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const Client = require('../../lib/client');
const policies = require('../../lib/policies');
const helper = require('../test-helper');
const errors = require('../../lib/errors');
const utils = require('../../lib/utils');
const types = require('../../lib/types');
const HostMap = require('../../lib/host').HostMap;
const Host = require('../../lib/host').Host;
const Metadata = require('../../lib/metadata');
const Encoder = require('../../lib/encoder');
const ProfileManager = require('../../lib/execution-profile').ProfileManager;
const ExecutionProfile = require('../../lib/execution-profile').ExecutionProfile;
const clientOptions = require('../../lib/client-options');
const PrepareHandler = require('../../lib/prepare-handler');

describe('Client', function () {
  describe('constructor', function () {
    it('should throw an exception when contactPoints are not provided', function () {
      assert.throws(function () {
        return new Client({});
      }, TypeError);
      assert.throws(function () {
        return new Client({contactPoints: []});
      }, TypeError);
      assert.throws(function () {
        return new Client(null);
      }, TypeError);
      assert.throws(function () {
        return new Client();
      }, TypeError);
    });

    it('should create Metadata instance', function () {
      const client = new Client({ contactPoints: ['192.168.10.10'] });
      assert.instanceOf(client.metadata, Metadata);
    });

    context('with useBigIntAsLong or useBigIntAsVarint set', () => {
      if (typeof BigInt === 'undefined') {
        it('should throw an error on engines that do not support it', () => {
          [{ useBigIntAsLong: true }, { useBigIntAsVarint: true }].forEach(encoding => {
            assert.throws(() => new Client({ contactPoints: ['10.10.1.1' ], encoding }),
              /BigInt is not supported by the JavaScript engine/);
          });
        });
      }
    });
  });

  describe('#connect()', function () {
    this.timeout(35000);
    it('should fail if no host name can be resolved', function (done) {
      const contactPoints = ['not1.existent-host', 'not2.existent-host'];
      const options = utils.extend({}, helper.baseOptions, { contactPoints });
      const client = new Client(options);
      client.connect(function (err) {
        assert.ok(err);
        assert.instanceOf(err, errors.NoHostAvailableError);
        assert.match(err.message, /resolve/);
        assert.ok(client.hosts);
        assert.lengthOf(client.hosts, 0);

        const resolvedContactPoints = client.controlConnection.getResolvedContactPoints();
        contactPoints.forEach(name => assert.strictEqual(resolvedContactPoints.get(name), utils.emptyArray));

        done();
      });
    });
    it('should connect once and queue if multiple calls in parallel', function (done) {
      let initCounter = 0;
      let emitCounter = 0;
      const options = utils.extend({
        contactPoints: helper.baseOptions.contactPoints,
        policies: {
          loadBalancing: new policies.loadBalancing.RoundRobinPolicy()
        },
        pooling: {
          warmup: false
        }
      });
      const ccMock = getControlConnectionMock(null, options);
      ccMock.prototype.init = function (cb) {
        initCounter++;
        //Async
        setTimeout(cb, 100);
      };

      const Client = proxyquire('../../lib/client.js', {
        './control-connection': ccMock
      });
      const client = new Client(options);
      client.on('connected', function () {emitCounter++;});
      utils.times(1000, function (n, next) {
        client.connect(function (err) {
          assert.ifError(err);
          next();
        });
      }, function (err){
        assert.ifError(err);
        assert.strictEqual(emitCounter, 1);
        assert.strictEqual(initCounter, 1);
        done();
      });
    });
    it('should fail when trying to connect after shutdown', function (done) {
      const options = utils.extend({
        contactPoints: helper.baseOptions.contactPoints,
        policies: {
          loadBalancing: new policies.loadBalancing.RoundRobinPolicy()
        },
        pooling: {
          warmup: false
        }
      });
      const client = new Client(options);
      client.controlConnection = {
        init: helper.callbackNoop,
        hosts: new HostMap(),
        host: { setDistance: utils.noop },
        profileManager: new ProfileManager(options),
        shutdown: utils.noop
      };
      utils.series([
        client.connect.bind(client),
        client.shutdown.bind(client)
      ], function (err) {
        assert.ifError(err);
        client.connect(function (err) {
          assert.instanceOf(err, errors.NoHostAvailableError);
          assert.ok(err.message.indexOf('after shutdown') >= 0, 'Error message does not contain occurrence: ' + err.message);
          done();
        });
      });
    });
    context('with no callback specified', function () {
      it('should return a promise', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.connect();
        assert.instanceOf(p, Promise);
        p.catch(function (err) {
          assert.instanceOf(err, errors.NoHostAvailableError);
          done();
        });
      });
    });
  });

  describe('#execute()', function () {
    it('should not support named parameters for simple statements', function (done) {
      const client = newConnectedInstance();
      client.execute('QUERY', {named: 'parameter'}, function (err) {
        assert.instanceOf(err, errors.ArgumentError);
        done();
      });
    });
    it('should build the routingKey based on routingNames', function (done) {
      const requestHandlerMock = {
        send: function (request, options, client, cb) {
          assert.ok(options);
          assert.ok(options.getRoutingKey());
          // eslint-disable-next-line no-useless-concat
          assert.strictEqual(options.getRoutingKey().toString('hex'), '00040000000100' + '00040000000200');
          cb();
          done();
        }
      };
      const prepareHandlerMock = {
        getPrepared: function (c, lbp, q, ks, cb) {
          cb(null, utils.allocBufferFromArray([1]), {
            columns: [
              { name: 'key1', type: { code: types.dataTypes.int} },
              { name: 'key2', type: { code: types.dataTypes.int} }
            ],
            partitionKeys: [0, 1]
          });
        }
      };
      const client = newConnectedInstance(requestHandlerMock, null, prepareHandlerMock);
      const query = 'SELECT * FROM dummy WHERE id2=:key2 and id1=:key1';
      const queryOptions = { prepare: true };
      client.execute(query, { key2: 2, key1: 1 }, queryOptions, helper.throwop);
    });
    it('should build the routingKey based on routingNames for query requests', function (done) {
      const requestHandlerMock = {
        send: function (request, options, client, cb) {
          assert.ok(options);
          assert.ok(options.getRoutingKey());
          // eslint-disable-next-line no-useless-concat
          assert.strictEqual(options.getRoutingKey().toString('hex'), '00040000000100' + '00040000000200');
          cb();
          done();
        }
      };
      const client = newConnectedInstance(requestHandlerMock, null);
      client.controlConnection = { protocolVersion: types.protocolVersion.maxSupported };
      const query = 'SELECT * FROM dummy WHERE id2=:key2 and id1=:key1';
      const queryOptions = { routingNames: ['key1', 'key2'], hints: { key1: 'int', key2: 'int' } };
      client.execute(query, { key2: 2, key1: 1 }, queryOptions, helper.throwop);
    });
    it('should fill parameter information for string hints', function (done) {
      let execOptions;
      const requestHandlerMock = {
        send: function (r, o, client, cb) {
          execOptions = o;
          cb();
        }
      };
      const client = newConnectedInstance(requestHandlerMock);
      client.metadata.getUdt = function (ks, n, cb) {
        cb(null, {keyspace: ks, name: n});
      };
      const query = 'SELECT * FROM dummy WHERE id2=:key2 and id1=:key1';
      const queryOptions = { prepare: false, hints: ['int', 'list<uuid>', 'map<text, timestamp>', 'udt<ks1.udt1>', 'map<uuid, set<text>>']};
      client.execute(query, [0, 1, 2, 3, 4], queryOptions, function (err) {
        assert.ifError(err);
        assert.ok(execOptions);
        const hints = execOptions.getHints();
        assert.ok(hints);
        assert.ok(hints[0]);
        assert.strictEqual(hints[0].code, types.dataTypes.int);
        assert.ok(hints[1]);
        assert.strictEqual(hints[1].code, types.dataTypes.list);
        assert.ok(hints[1].info);
        assert.strictEqual(hints[1].info.code, types.dataTypes.uuid);
        assert.ok(hints[2]);
        assert.strictEqual(hints[2].code, types.dataTypes.map);
        assert.ok(util.isArray(hints[2].info));
        assert.strictEqual(hints[2].info[0].code, types.dataTypes.text);
        assert.strictEqual(hints[2].info[1].code, types.dataTypes.timestamp);
        assert.ok(hints[3]);
        assert.strictEqual(hints[3].code, types.dataTypes.udt);
        assert.ok(hints[3].info);
        assert.strictEqual(hints[3].info.keyspace, 'ks1');
        //nested collections
        assert.ok(hints[4]);
        assert.strictEqual(hints[4].code, types.dataTypes.map);
        assert.ok(util.isArray(hints[4].info));
        assert.ok(hints[4].info[0]);
        assert.propertyVal(hints[4].info[0], 'code', types.dataTypes.uuid);
        assert.strictEqual(hints[4].info[1].code, types.dataTypes.set);
        assert.strictEqual(hints[4].info[1].info.code, types.dataTypes.text);
        done();
      });
    });
    it('should callback with an argument error when the hints are not valid strings', function (done) {
      const requestHandlerMock = {
        send: function (request, o, client, cb) {
          cb();
        }
      };
      const client = newConnectedInstance(requestHandlerMock);
      const query = 'SELECT * FROM dummy WHERE id2=:key2 and id1=:key1';
      utils.series([
        function (next) {
          client.execute(query, [], { hints: ['int2']}, function (err) {
            assert.instanceOf(err, TypeError);
            next();
          });
        },
        function (next) {
          client.execute(query, [], { hints: ['map<zeta>']}, function (err) {
            assert.instanceOf(err, TypeError);
            next();
          });
        },
        function (next) {
          client.execute(query, [], { hints: ['udt<myudt>']}, function (err) {
            assert.instanceOf(err, TypeError);
            next();
          });
        }
      ], done);
    });
    it('should use the default execution profile options', function () {
      const profile = new ExecutionProfile('default', {
        consistency: types.consistencies.three,
        readTimeout: 12345,
        retry: new policies.retry.RetryPolicy(),
        serialConsistency: types.consistencies.localSerial
      });
      const options = getOptions({ profiles: [ profile ] });
      const client = new Client(options);
      let execOptions = null;
      client._innerExecute = function (q, p, o) {
        execOptions = o;
      };
      client.execute('Q', [], { }, utils.noop);

      assert.strictEqual(execOptions.getRetryPolicy(), profile.retry);
      assert.strictEqual(execOptions.getReadTimeout(), profile.readTimeout);
      assert.strictEqual(execOptions.getSerialConsistency(), profile.serialConsistency);
      assert.strictEqual(execOptions.getConsistency(), profile.consistency);
    });
    it('should use the provided execution profile options', function () {
      const profile = new ExecutionProfile('profile1', {
        consistency: types.consistencies.three,
        readTimeout: 54321,
        retry: new policies.retry.RetryPolicy(),
        serialConsistency: types.consistencies.localSerial
      });
      const options = getOptions({ profiles: [ profile ] });
      const client = new Client(options);
      let execOptions = null;
      client._innerExecute = function (q, p, o) {
        execOptions = o;
      };

      const items = [
        // profile by name
        { executionProfile: 'profile1' },
        // profile by instance
        { executionProfile: profile }
      ];

      items.forEach(queryOptions => {
        client.execute('Q1', [], queryOptions, utils.noop);

        // Verify the profile options
        assert.strictEqual(execOptions.getRetryPolicy(), profile.retry);
        assert.strictEqual(execOptions.getReadTimeout(), profile.readTimeout);
        assert.strictEqual(execOptions.getSerialConsistency(), profile.serialConsistency);
        assert.strictEqual(execOptions.getConsistency(), profile.consistency);
      });
    });
    it('should override the provided execution profile options with provided options', function () {
      const profile = new ExecutionProfile('profile1', {
        consistency: types.consistencies.three,
        readTimeout: 54321,
        retry: new policies.retry.RetryPolicy(),
        serialConsistency: types.consistencies.localSerial
      });
      const options = getOptions({ profiles: [ profile ] });
      const client = new Client(options);
      let execOptions = null;
      client._innerExecute = function (q, p, o) {
        execOptions = o;
      };

      const items = [
        // profile by name
        { consistency: types.consistencies.all, executionProfile: 'profile1' },
        // profile by instance
        { consistency: types.consistencies.all, executionProfile: profile }
      ];

      items.forEach(queryOptions => {
        client.execute('Q1', [], queryOptions, utils.noop);

        // Verify the profile options
        assert.strictEqual(execOptions.getRetryPolicy(), profile.retry);
        assert.strictEqual(execOptions.getReadTimeout(), profile.readTimeout);
        assert.strictEqual(execOptions.getSerialConsistency(), profile.serialConsistency);

        // Verify the overridden option
        assert.strictEqual(execOptions.getConsistency(), types.consistencies.all);
      });
    });
    it('should set the timestamp', function (done) {
      let execOptions;
      const handlerMock = {
        send: function (r, o, client, cb) {
          execOptions = o;
          cb(null, {});
        }
      };
      const client = newConnectedInstance(handlerMock);
      utils.eachSeries([1, 2, 3, 4], function (version, next) {
        client.controlConnection.protocolVersion = version;
        client.execute('Q', function (err) {
          assert.ifError(err);
          assert.ok(execOptions);
          const timestamp = execOptions.getOrGenerateTimestamp();
          if (version > 2) {
            assert.ok(timestamp);
            assert.ok((timestamp instanceof types.Long) || typeof timestamp === 'number');
          }
          else {
            assert.strictEqual(timestamp, null);
          }
          next();
        });
      }, done);
    });
    it('should not set the timestamp when timestampGeneration is null', function (done) {
      let execOptions;
      const handlerMock = {
        send: function (r, o, client, cb) {
          execOptions = o;
          cb(null, {});
        }
      };
      const client = newConnectedInstance(handlerMock, { policies: { timestampGeneration: null }});
      client.controlConnection.protocolVersion = 4;
      client.execute('Q', function (err) {
        assert.ifError(err);
        assert.ok(execOptions);
        assert.strictEqual(execOptions.getOrGenerateTimestamp(), null);
        done();
      });
    });
    context('with no callback specified', function () {
      it('should return a promise', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.execute('Q', [ 1, 2 ], { prepare: true });
        assert.instanceOf(p, Promise);
        p.catch(function (err) {
          assert.instanceOf(err, errors.NoHostAvailableError);
          done();
        });
      });
      it('should reject the promise when an ExecutionProfile is not found', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.execute('Q', [ 1, 2 ], { executionProfile: 'non_existent' });
        assert.instanceOf(p, Promise);
        p.catch(function (err) {
          assert.instanceOf(err, errors.ArgumentError);
          done();
        });
      });
    });
  });
  describe('#batch()', function () {
    const requestHandlerMock = {
      send: function (r, o, client, cb) {
        // Make it async
        setTimeout(function () {
          cb(null, {meta: {}});
        }, 50);
      }
    };

    const Client = proxyquire('../../lib/client.js', {
      './request-handler': requestHandlerMock
    });

    it('should internally call to connect', function (done) {
      const client = new Client(helper.baseOptions);
      const connect = sinon.fake(cb => cb());
      sinon.replace(client, 'connect', connect);
      client.batch(['q1'], function (err) {
        assert.ifError(err);
        assert.isTrue(connect.calledOnce);
        done();
      });
    });
    it('should set the timestamp', function (done) {
      let execOptions;
      const handlerMock = {
        send: function (r, i, client, cb) {
          execOptions = i;
          cb(null, {});
        }
      };
      const client = newConnectedInstance(handlerMock);
      utils.eachSeries([1, 2, 3, 4], function (version, next) {
        client.controlConnection.protocolVersion = version;
        client.batch(['q1', 'q2', 'q3'], function (err) {
          assert.ifError(err);
          assert.ok(execOptions);
          const timestamp = execOptions.getOrGenerateTimestamp();
          if (version > 2) {
            assert.ok(timestamp);
            assert.ok((timestamp instanceof types.Long) || typeof timestamp === 'number');
          }
          else {
            assert.isNull(timestamp);
          }
          next();
        });
      }, done);
    });
    context('with no callback specified', function () {
      it('should return a promise', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.batch(['Q'], null);
        assert.instanceOf(p, Promise);
        p.catch(function (err) {
          assert.instanceOf(err, errors.NoHostAvailableError);
          done();
        });
      });
      it('should reject the promise when queries is not an Array', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.batch('Q', null);
        assert.instanceOf(p, Promise);
        p.catch(function (err) {
          assert.instanceOf(err, errors.ArgumentError);
          done();
        });
      });
    });
  });

  describe('#batch(queries, {prepare: 1}, callback)', function () {
    it('should callback with error if the queries are not string', function (done) {
      const client = newConnectedInstance(undefined, undefined, PrepareHandler);
      client.batch([{ noQuery: true }], { prepare: true }, function (err) {
        assert.instanceOf(err, errors.ArgumentError);
        done();
      });
    });
    it('should callback with error if the queries are undefined', function (done) {
      const client = newConnectedInstance(undefined, undefined, PrepareHandler);
      client.batch([ undefined, undefined, 'q3' ], { prepare: true }, function (err) {
        assert.instanceOf(err, errors.ArgumentError);
        done();
      });
    });
  });

  describe('#shutdown()', function () {
    const options = clientOptions.extend({}, helper.baseOptions, {
      policies: { reconnection: new policies.reconnection.ConstantReconnectionPolicy(100)},
      logEmitter: helper.noop
    });
    it('should set connected flag to false when hosts successfully shutdown', function(done) {
      const hosts = new HostMap();
      const h1 = new Host('192.1.1.1', 1, options);
      h1.datacenter = "dc1";
      h1.pool.connections = [{close: setImmediate}];
      const h2 = new Host('192.1.1.2', 1, options);
      h2.datacenter = "dc1";
      h2.pool.connections = [{close: setImmediate}];
      hosts.push(h1.address, h1);
      hosts.push(h2.address, h2);

      const Client = proxyquire('../../lib/client', {
        './control-connection': getControlConnectionMock(hosts)
      });

      const client = new Client(options);
      client.shutdown(function(){
        assert.equal(client.connected, false);
        done();
      });
    });
    it('should callback when called multiple times serially', function (done) {
      const hosts = new HostMap();
      const h1 = new Host('192.1.1.1', 1, options);
      h1.datacenter = "dc1";
      h1.pool.connections = [{close: setImmediate}];
      const h2 = new Host('192.1.1.2', 1, options);
      h2.datacenter = "dc1";
      h2.pool.connections = [{close: setImmediate}];
      hosts.push(h1.address, h1);
      hosts.push(h2.address, h2);
      const Client = proxyquire('../../lib/client', {
        './control-connection': getControlConnectionMock(hosts)
      });
      const client = new Client(options);
      utils.series([
        client.connect.bind(client),
        function shutDownMultiple(seriesNext) {
          utils.timesSeries(10, function(n, next) {
            client.shutdown(next);
          }, seriesNext);
        }
      ], done);
    });
    it('should callback when called multiple times in parallel', function (done) {
      const hosts = new HostMap();
      const h1 = new Host('192.1.1.1', 1, options);
      h1.datacenter = "dc1";
      h1.pool.connections = [{close: setImmediate}];
      const h2 = new Host('192.1.1.2', 1, options);
      h2.datacenter = "dc1";
      h2.pool.connections = [{close: setImmediate}];
      hosts.push(h1.address, h1);
      hosts.push(h2.address, h2);
      const Client = proxyquire('../../lib/client', {
        './control-connection': getControlConnectionMock(hosts)
      });
      const client = new Client(options);
      utils.series([
        client.connect.bind(client),
        function shutDownMultiple(seriesNext) {
          utils.times(100, function(n, next) {
            client.shutdown(next);
          }, seriesNext);
        }
      ], done);
    });
    it('should not attempt reconnection and log after shutdown', function (done) {
      const rp = new policies.reconnection.ConstantReconnectionPolicy(50);
      const client = new Client(utils.extend({}, helper.baseOptions, { policies: { reconnection: rp } }));
      const logEvents = [];
      client.on('log', logEvents.push.bind(logEvents));
      client.connect(function (err) {
        assert.instanceOf(err, errors.NoHostAvailableError);
        client.shutdown(function clientShutdownCallback(err) {
          assert.ifError(err);
          setTimeout(function () {
            logEvents.length = 0;
            setTimeout(function assertAfterSomeTime() {
              assert.strictEqual(
                logEvents.length, 0, 'Expected no log events after shutdown but was: ' + util.inspect(logEvents));
              done();
            }, 100);
          }, 20);
        });
      });
    });
    context('with no callback specified', function () {
      it('should return a promise', function (done) {
        const client = new Client(helper.baseOptions);
        const p = client.shutdown();
        assert.instanceOf(p, Promise);
        p.then(done);
      });
    });
  });

  describe('#_waitForSchemaAgreement()', function () {
    let clock;

    before(() => clock = sinon.useFakeTimers({ shouldAdvanceTime: true }));
    after(() => clock.restore());

    it('should continue querying until the version matches', function (done) {
      const client = new Client(helper.baseOptions);
      client.hosts = { length: 5 };
      let calls = 0;
      client.metadata = {
        compareSchemaVersions: (c, cb) => {
          cb(null, ++calls === 3);
        }
      };

      client._waitForSchemaAgreement(null, function (err) {
        assert.ifError(err);
        assert.strictEqual(calls, 3);
        done();
      });

      clock.tick(5000);
    });

    it('should timeout if there is no agreement', function (done) {
      const client = new Client(utils.extend({}, helper.baseOptions, {
        protocolOptions: { maxSchemaAgreementWaitSeconds: 1 }
      }));
      client.hosts = { length: 5 };
      client.metadata = {
        compareSchemaVersions: sinon.fake((c, cb) => cb(null, false))
      };

      client._waitForSchemaAgreement(null, function (err) {
        assert.ifError(err);
        assert.isAbove(client.metadata.compareSchemaVersions.callCount, 0);
        done();
      });

      clock.tick(5000);
    });

    it('should callback when there is an error retrieving versions', function (done) {
      const client = new Client(helper.baseOptions);
      client.hosts = {length: 3};
      const dummyError = new Error('dummy error');
      client.metadata = {
        compareSchemaVersions: (c, cb) => cb(dummyError)
      };

      client._waitForSchemaAgreement(null, function (err) {
        assert.strictEqual(err, dummyError);
        done();
      });
    });
  });
});

function getControlConnectionMock(hosts, options) {
  function ControlConnectionMock() {
    this.hosts = hosts || new HostMap();
    this.metadata = new Metadata(options || {});
    this.profileManager = newProfileManager(options);
    this.host = { setDistance: utils.noop };
    this.shutdown = utils.noop;
  }
  ControlConnectionMock.prototype.init = setImmediate;

  return ControlConnectionMock;
}

function getOptions(options) {
  return clientOptions.extend({ contactPoints: ['hostip1']}, options);
}

function newProfileManager(options) {
  return new ProfileManager(getOptions(options));
}

function newConnectedInstance(requestHandlerMock, options, prepareHandlerMock) {
  const Client = proxyquire('../../lib/client', {
    './request-handler': requestHandlerMock || function () {},
    './prepare-handler': prepareHandlerMock || function () {}
  });

  const client = new Client(utils.extend({}, helper.baseOptions, options));
  client._getEncoder = () => new Encoder(2, {});
  client.connect = helper.callbackNoop;

  return client;
}