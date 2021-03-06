"use strict";

const develop = require('debug')('develop');
const error = require('debug')('error');

const _ = require('lodash');
const Promise = require('bluebird');
let co = require('co');
let eve = require('evejs');
const mqtt = require('mqtt');

const EventEmitter = require('events').EventEmitter;

function Agent(agent) {
  // execute super constructor and set agent-id
  eve.Agent.call(this, agent.id);

  // Setup transports
  eve.system.init({
    transports: agent.transports
  });
  this.timer = {};
  this.timer.setTimeout = setTimeout;
  this.timer.getTime = Date.now;

  // MQTT Connection
  if(agent.mqtt) {
    console.log('using mqtt:', agent.mqtt);
    this.mqtt = mqtt.connect(agent.mqtt);
  }

  this.services = [];

  // set Directory Facilitator
  this.DF = agent.DF;

  // EventEmitter
  this.events = new EventEmitter();

  // load the RPC module
  this.rpc = this.loadModule('rpc', this.rpcFunctions, {timeout: 2*1000});

  // babblify the agent
  this.extend('babble');
  //this.babble = this.loadModule('babble');

  // connect to all transports provided by the system
  this.connect(eve.system.transports.getAll());
}
Agent.prototype = Object.create(eve.Agent.prototype);
Agent.prototype.constructor = Agent; // not needed?

Agent.prototype.rpcFunctions = {};
Agent.prototype.rpcFunctions.dummy = function(params, from) {
  console.log('#dummy - RPC from:', from, params);
  return {err: 'dummy not yet implemented'};
};

// Service Handling  =======================================================
/**
 * add a service to an agent
 * @param name [string] name of service
 * @param func [function] func(params, from)
 */
Agent.prototype.serviceAdd = function(name, func){
  this.services.push(name);
  this.rpcFunctions[name] = func;
};
Agent.prototype.getServices = function(){
  return this.services;
};

Agent.prototype.register = function(){
  // Register services
  var self = this;
  return this.request(this.DF, 'register', {services: this.services})
    .then(function(reply){
      develop(reply);
      if(reply.err) throw new Error('#register could not be performed: ' + reply.err);
      else if (_.isEmpty(reply)){
        throw new Error('#register could not be performed. DF not reachable? ' + reply.err);
      } else {
        self.events.emit('registered', reply);
        return Promise.resolve(reply);
      }
    });
};

Agent.prototype.deRegister = function(){
  // Deregister services
  var self = this;
  //return new Promise((resolve, reject)=>{
  return this.request(this.DF, 'deRegister')
    .then(function(reply){
      if(reply.err) throw new Error('#deregister could not be performed' + reply.err);
      else {
        let ret = 'deRegister succesfull';
        self.events.emit('deRegistered', ret);
        return Promise.resolve(ret);
      }
    });
};

Agent.prototype.searchService = function(service){
  return this.request(this.DF,'search', {service: service})
    .then(function(reply){
      if(reply.err) {
        throw new Error('#search could not be performed' + reply.err);
      } else if(_.isEmpty(reply)) {
        throw new Error('no service was found. service:'+service);
      } else {
        develop('#search service:',service,':',reply);
        return Promise.resolve(reply);
      }
    });
};

/**
 * wrapper for rpc.request
 * @param to
 * @param method
 * @param params
 * @returns {*|Promise.<T>}
 */
Agent.prototype.request = function(to, method, params) {
  let sniffing = {to: to, from: this.id, type: 'rpc', method: method, params: params};
  this.sendToSniffer(sniffing);
  develop(sniffing);

  return this.rpc.request(to, {method: method, params: params})
    .then(function(reply){
      return Promise.resolve(reply);
    })
    .catch(function(err){
      // RPC Timeout probably
      throw new Error('RPC Timeout? Or Agent.request internal error. err='+err);
    });
};
// Service Handling End =================================================

// Communicative Acts ===================================================
// cfp
Agent.prototype.CAcfp = function(participant, conversation, objective){
  let sniffing = {to: participant, from: this.id, type: 'CAcfp', conversation: conversation, objective: objective};
  develop(sniffing);
  this.sendToSniffer(sniffing);

  return new Promise( (resolve, reject) => {
    this.tell(participant, conversation)
      .tell(function (message, context) {
        return objective;
      })
      .listen(function (message, context) {
        develop('refuse/propose?', context, ': ', message);
        return message;
      })
      .tell(function (message, context) {
        if (message.propose) {
          develop('proposed:', message);
          let ret = message.propose;
          ret.agent = context.from; //add seller name to propositions
          resolve(ret);
        } else {
          develop('no propose', message);
          resolve(message);
        }
      });
    })
    .timeout(1000)
    .catch(Promise.TimeoutError, function(e) {
      console.error(`agent ${participant} is not reachable within 1000ms`);
      return Promise.resolve({error: `Promise timeout - agent ${participant} is not reachable within 1000ms`});
    });
};

Agent.prototype.CAcfpAcceptProposal = function(seller, conversation, objective){
  let conv = conversation + '-accept';

  let sniffing = {to: seller, from: this.id, type: 'CAcfpAcceptProposal', conversation: conversation, objective: objective};
  develop(sniffing);
  this.sendToSniffer(sniffing);

  return new Promise( (resolve, reject) => {
    this.tell(seller, conv)
      .tell(function (message, context) {
        return objective;
      })
      .listen(function (message, context) {
        develop('failure, done, result?', context, ': ', message);
        resolve(message);
      })
  });
};

/**
 *
 * @param conversation
 * @param doTell Promise // promise for internal error handling, otherwise silent error-failing
 * @constructor
 */
Agent.prototype.CAcfpListener = function (conversation, doTell){
  let self = this;
  function cb(message, context) {
    if (self.mqtt) {
      // Hook into the promise chain
      return doTell(message, context)
        .then(function(reply) {
          let sniffing = {from: self.id, to: context.from, type: 'CAcfpListener', message: reply};
          develop(sniffing);
          self.sendToSniffer(sniffing);
          return reply;
        });
    } else {
      return doTell(message, context);
    }
  }

  this.listen(conversation)
    .listen(function (message, context) { // cfp (book-title)
      let sniffing = {from: self.id, to: context.from, type: 'CAcfpListener', message: message};
      develop(sniffing);
      return message;
    })
    .tell(cb);
};

/**
 *
 * @param conversation
 * @param doAccept Promise // promise for internal error handling, otherwise silent error-failing
 * @constructor
 */
Agent.prototype.CAcfpAcceptProposalListener = function (conversation, doAccept) {
  let conv = conversation + '-accept';
  let self = this;
  function cb(message, context) {
    if (self.mqtt) {
      // Hook into the promise chain
      return doAccept(message, context)
        .then(function(reply) {
          self.sendToSniffer({from: self.id, to: context.from, type: 'CAcfpListener', message: reply});
          return reply;
        });
    } else {
      return doAccept(message, context);
    }
  }

  this.listen(conv)
    .listen(function (message, context) { // cfp (book-title)
      develop('in ', conv ,':' , message);
      return message;
    })
    .tell(cb);
};


Agent.prototype.searchAndSelectServiceBy = function(service, objective, criteria) {
  let self = this;

  return co(function* () {
    let agents = yield self.searchService(service);
    let propositions = yield Promise.all(agents.map(function(agent){
      return self.CAcfp(agent.agent, service, objective);
    }));
    let selectedProposition =  _.minBy(propositions, criteria);
    develop('selectedProposition', selectedProposition);
    let reply = yield self.CAcfpAcceptProposal(selectedProposition.agent, service, objective);
    if(reply.inform) {
      let ret = {agent: selectedProposition.agent, taskId: reply.inform.taskId};
      return yield Promise.resolve(ret);
    } else {
      throw new Error('failure in reservation', reply);
    }
  }).catch(error);
};

/**
 *
 * @param conversation
 * @param cfpListener function(message, context) return Promise(resolve({propose: / failure: }););
 * @param acceptListener function(message, context)
 */
Agent.prototype.serviceAddCAcfpParticipant = function(conversation, cfpListener, acceptListener) {
  this.serviceAdd(conversation, '');

  this.CAcfpListener(conversation, cfpListener);
  this.CAcfpAcceptProposalListener(conversation, acceptListener);
};

// cfp end

/**
 * conversation helper for a simple request - returns a promise
 * @param participant String (agent-id)
 * @param conversation String ('request-conversation')
 * @param objective Object (e.g. {title: 'Harry Potter'})
 * @returns {bluebird|exports|module.exports}
 * @constructor
 */
Agent.prototype.CArequest = function (participant, conversation, objective){
  develop('CArequest', participant, conversation, objective);

  this.sendToSniffer({to: participant, from: this.id, type: 'CArequest', conversation: conversation, objective: objective});

  return new Promise( (resolve, reject) => {
    this.tell(participant, conversation)
      .tell(function (message, context) {
        return objective;
      })
      .listen(function (message, context) {
        develop('CArequest inform/failure?', context, ': ', message);
        return message;
      })
      .tell(function (message, context) {
        if (message.failure) {
          develop('failure', message.failure);
          reject(message.failure);
        }
        if (message.inform) {
          develop('inform:', message);
          let ret = {};
          ret.inform = message.inform;
          ret.agent = context.from; //add seller name to propositions
          resolve(ret);
        }
      });
  });
};
/**
 * Helper for request participant. Executes a given promise when called
 * @param conversation String ('request-conversation')
 * @param executeRequest Function(Promise) function(message, context) or function(objective)
 * @constructor
 */
Agent.prototype.CArequestParticipant = function (conversation, executeRequest) {
  let self = this;
  function cb(message, context) {
    if (self.mqtt) {
      // Hook into the promise chain
      return executeRequest(message, context)
        .then(function(reply) {
          self.sendToSniffer({from: self.id, to: context.from, type: 'CArequestParticipant', message: reply});
          return reply;
        });
    } else {
      return executeRequest(message, context);
    }
  }
  this.listen(conversation)
    .listen(function (message, context) { // cfp (book-title)
      develop('#CArequestParticipant', message);
      return message;
    })
    .tell(cb);
};
// Communicative Acts End ================================================

// Helper
Agent.prototype.sendToSniffer = function (obj) {
  let sniff = obj;
  sniff.time = this.timer.getTime();
  if(this.mqtt) {
    this.mqtt.publish('sniffer', JSON.stringify(sniff));
  }
};

module.exports = Agent;
