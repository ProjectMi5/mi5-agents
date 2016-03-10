"use strict";

const config = require('./../../config.js');

const _ = require('lodash');
const babble = require('babble');
const develop = require('debug')('develop');
const Promise = require('bluebird');
const uuid = require('uuid-v4');
const co = require('co');
let GeneralAgent = require('./../../agents/GeneralAgent');

var agentOptions = {
  id: 'Cocktail',
  DF: config.DF,
  transports: [
    {
      type: 'amqp',
      url: config.amqpHost
      //host: 'dev.rabbitmq.com'
    }
  ],
  mqtt: config.mqttHost
};

var Agent = new GeneralAgent(agentOptions);

Agent.position = 500;

Agent.liquids = [
  {type: 'grenadine', amount: '10000'},
  {type: 'lemon', amount: '10000'},
  {type: 'maracuja', amount: '10000'},
  {type: 'pineapple', amount: '10000'},
  {type: 'orange', amount: '10000'},
  {type: 'strawberry', amount: '10000'},
  {type: 'bluecuracao', amount: '10000'},
  {type: 'water', amount: '10000'}
];
Agent.taskList = [];

Agent.execute = function(job){
  return new Promise( (resolve, reject) => {
    // if position can be reached
      console.log('execute.......', JSON.stringify(job));
      setTimeout(resolve, 2000);

  });
};

Promise.all([Agent.ready]).then(function () {
  Agent.events.on('registered',console.log);

  Agent.skillAddCAcfpParticipant('cfp-fill', checkParameters, reserve);
  Agent.skillAdd('getPosition', function(){ return Agent.position; });

  function checkParameters (message, context) {
    return new Promise( (resolve, reject) => {
      develop('#checkParams', message, context);
      //let book = _.find(Agent.books, {title: message.title});
      if(true) {
        let offer = {price: Math.random()};
        develop('offer:', offer);
        resolve({propose: offer });
      } else {
        develop('not in stock');
        resolve({refuse: 'not in stock'});
      }
    }).catch(console.error);
  }

  function reserve(message, context) {
    return new Promise( (resolve, reject) => {
      develop('#reserve', message, context);

      let task = {
        taskId: 'fill-'+uuid(),
        parameters: message
      };
      Agent.taskList.push(task);

      if(true) {
        develop('inform-result:', task);
        resolve({informDone: task}); // propose
      } else {
        develop('book could not be fetched in stock');
        resolve({failure: 'book could not be fetched in stock'}); // refuse
      }
    }).catch(console.error);
  }

  Agent.CArequestParticipant('request-give', give);
  function give(message, context){
    develop('#give', message, context);
    return new Promise((resolve, reject) => {
      resolve({inform: 'here you have it'});
    });
  }

  Agent.CArequestParticipant('request-take', take);
  function take(message, context){
    develop('#take', message, context);
    return new Promise((resolve, reject) => {
      resolve({inform: 'i took it'});
    });
  }

  Agent.CArequestParticipant('request-execute', execute);
  function execute (objective, context) {
    develop('#execute', objective, context);

    return new Promise((resolve, reject) => {
      co(function* () {
        let job = _.find(Agent.taskList, {taskId: objective.taskId});
        console.log('task', job);
        if(typeof job == 'undefined') {
          throw new Error('job was not found in taskList:', Agent.taskList);
        }
        yield Agent.execute(job);
        _.remove(Agent.taskList, {taskId: job.taskId});
        develop('task successfully finished. removed. taskList:', Agent.taskList);
        resolve({inform: 'done'});

      }).catch(console.error);
    });
  }

  // Register Skills
  Agent.register()
    .catch(console.log);

  // deRegister upon exiting
  process.on('SIGINT', function(){
    console.log('taking down...');
    Agent.deRegister();
    setTimeout(process.exit, 500); // wait for deregistering complete
  });

}).catch(function(err){console.log('exe',err)});
