'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const BaseJob = require('./BaseJob');
const CONST = require('../constants');
const ScheduleManager = require('./ScheduleManager');
const utils = require('../utils');
const logger = require('../logger');
const errors = require('../errors');
const config = require('../config');
const bosh = require('../bosh');
const catalog = require('../models').catalog;
const DirectorManager = require('../fabrik/DirectorManager');
const ServiceFabrikOperation = require('../fabrik/ServiceFabrikOperation');
const eventmesh = require('../../../eventmesh');
const EventLogInterceptor = require('../../../common/EventLogInterceptor');

class BnRStatusPollerJob extends BaseJob {
  constructor() {
    super();
  }

  static run(job, done) {
    job.__started_At = new Date();
    const options = job.attrs.data;
    logger.info(`-> Starting BnRStatusPollerJob -  name: ${options[CONST.JOB_NAME_ATTRIB]}
          - operation: ${options.operation} - with options: ${JSON.stringify(options)} `);
    if (!_.get(options, 'operation_details.instance_guid') || !_.get(options, 'type') ||
      !_.get(options, 'operation') || !_.get(options, 'operation_details.backup_guid') ||
      !_.get(options, 'operation_details.tenant_id') || !_.get(options, 'operation_details.plan_id') ||
      !_.get(options, 'operation_details.agent_ip') || !_.get(options, 'operation_details.started_at') ||
      !_.get(options, 'operation_details.deployment') || !_.get(options, 'operation_details.service_id')) {
      const msg = `BnR status poller cannot be initiated as the required mandatory params 
        (instance_guid | type | operation | backup_guid | tenant_id | plan_id | agent_ip | 
          started_at | deployment | service_id) is empty : ${JSON.stringify(options)}`;
      logger.error(msg);
      return this.runFailed(new errors.BadRequest(msg), {}, job, done);
    } else if (_.get(options, 'operation') !== 'backup') {
      const msg = `Operation polling not supported for operation - ${options.operation}`;
      logger.error(msg);
      const err = {
        statusCode: `ERR_${options.operation.toUpperCase()}_NOT_SUPPORTED`,
        statusMessage: msg
      };
      return this.runFailed(err, {}, job, done);
    } else {
      //modify the first argument here based on implementation of the function
      return this.checkOperationCompletionStatus(job.attrs.data)
        .then(operationStatusResponse => this.runSucceeded(operationStatusResponse, job, done))
        .catch(err => {
          logger.error(`Error occurred while running operation ${options.operation} status poller for instance ${_.get(options, 'instance_guid')}.`, err);
          return this.runFailed(err, {}, job, done);
        });
    }
  }

  static checkOperationCompletionStatus(job_data) {
    const operationName = job_data.operation;
    const instanceInfo = job_data.operation_details;
    const instance_guid = instanceInfo.instance_guid;
    const backup_guid = instanceInfo.backup_guid;
    const deployment = instanceInfo.deployment;
    const plan = catalog.getPlan(instanceInfo.plan_id);
    return Promise.try(() => {
        if (operationName === 'backup') {
          return DirectorManager
            .load(plan)
            .then(directorManager => directorManager.getServiceFabrikOperationState('backup', instanceInfo));
        }
      })
      .tap(operationStatusResponse => {
        return eventmesh
          .server
          .updateAnnotationKey({
            resourceId: instanceInfo.instance_guid,
            annotationName: 'backup',
            annotationType: 'default',
            annotationId: instanceInfo.backup_guid,
            key: 'progress',
            value: JSON.stringify(operationStatusResponse)
          });
      })
      .then(operationStatusResponse => {
        operationStatusResponse.jobCancelled = false;
        operationStatusResponse.operationTimedOut = false;
        operationStatusResponse.operationFinished = false;
        if (utils.isServiceFabrikOperationFinished(operationStatusResponse.state)) {
          operationStatusResponse.operationFinished = true;
          return operationStatusResponse;
        } else {
          logger.info(`Instance ${instance_guid} ${operationName} for backup guid ${backup_guid} still in-progress - `, operationStatusResponse);
          const currentTime = new Date();
          const backup_triggered_duration = (currentTime - new Date(instanceInfo.started_at)) / 1000;
          return Promise
            .try(() => bosh.director.getDirectorConfig(instanceInfo.deployment))
            .then(directorConfig => {
              const lock_deployment_max_duration = directorConfig.lock_deployment_max_duration;
              if (backup_triggered_duration > lock_deployment_max_duration) {
                //Operation timed out
                if (!instanceInfo.abortStartTime) {
                  //Operation not aborted. Aborting operation and with abort start time
                  // re-registering statupoller job
                  let abortStartTime = new Date().toISOString();
                  instanceInfo.abortStartTime = abortStartTime;
                  return DirectorManager
                    .load(plan)
                    .then(directorManager => directorManager.abortLastBackup(instanceInfo.tenant_id,
                      instanceInfo.instance_guid, true))
                    .then(() => DirectorManager.registerBnRStatusPoller(job_data, instanceInfo))
                    .then(() => {
                      operationStatusResponse.state = CONST.OPERATION.ABORTING;
                      return operationStatusResponse;
                    });
                } else {
                  // Operation aborted
                  const currentTime = new Date();
                  const abortDuration = (currentTime - new Date(instanceInfo.abortStartTime));
                  if (abortDuration < config.backup.abort_time_out) {
                    logger.info(`${operationName} abort is still in progress on : ${deployment} for guid : ${backup_guid}`);
                    operationStatusResponse.state = CONST.OPERATION.ABORTING;
                  } else {
                    operationStatusResponse.state = CONST.OPERATION.ABORTED;
                    logger.info(`Abort ${operationName} timed out on : ${deployment} for guid : ${backup_guid}. Flagging ${operationName} operation as complete`);
                    operationStatusResponse.operationTimedOut = true;
                    operationStatusResponse.operationFinished = true;
                  }
                  return operationStatusResponse;
                }
              } else {
                // Backup not timedout and still in-porogress
                return operationStatusResponse;
              }
            });
        }
      })
      .then(operationStatusResponse => operationStatusResponse.operationFinished ?
        this.doPostFinishOperation(operationStatusResponse, operationName, instanceInfo) :
        Promise.resolve(operationStatusResponse)
      );
  }
  static doPostFinishOperation(operationStatusResponse, operationName, instanceInfo) {
    return this
      .updateEventMesh(instanceInfo, operationName, operationStatusResponse)
      .then(() => ScheduleManager.cancelSchedule(`${instanceInfo.deployment}_${operationName}_${instanceInfo.backup_guid}`, CONST.JOB.BNR_STATUS_POLLER))
      .then(() => {
        if (operationStatusResponse.operationTimedOut) {
          const msg = `Deployment ${instanceInfo.instance_guid} ${operationName} with backup guid ${instanceInfo.backup_guid} exceeding timeout time
    ${config.backup.backup_restore_status_poller_timeout / 1000 / 60} (mins). Stopping status check`;
          logger.error(msg);
        } else {
          logger.info(`Instance ${instanceInfo.instance_guid} ${operationName} for backup guid ${instanceInfo.backup_guid} completed -`, operationStatusResponse);
        }
        operationStatusResponse.jobCancelled = true;
        return operationStatusResponse;
      });
  }
  static updateEventMesh(instanceInfo, operation, operationStatusResponse) {
    return Promise
      .try(() => {
        return eventmesh.server.updateAnnotationState({
          resourceId: instanceInfo.instance_guid,
          annotationName: 'backup',
          annotationType: 'default',
          annotationId: instanceInfo.backup_guid,
          stateValue: CONST.RESOURCE_STATE.SUCCEEDED
        })
      });
  }
}
module.exports = BnRStatusPollerJob;