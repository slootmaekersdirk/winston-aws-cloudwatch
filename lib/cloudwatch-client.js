const _debug = require('debug')
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs')
const CloudWatchEventFormatter = require('./cloudwatch-event-formatter')

const debug = _debug('winston-aws-cloudwatch:CloudWatchClient')

const DEFAULT_OPTIONS = {
  awsConfig: null,
  formatLog: null,
  formatLogItem: null,
  createLogGroup: false,
  createLogStream: false,
  submissionRetryCount: 1
}

class CloudWatchClient {
  constructor (logGroupName, logStreamName, options) {
    debug('constructor', { logGroupName, logStreamName, options })
    this._logGroupName = logGroupName
    this._logStreamName = logStreamName
    this._options = Object.assign({}, DEFAULT_OPTIONS, options)
    this._formatter = new CloudWatchEventFormatter(this._options)
    this._sequenceToken = null
    this._client = new CloudWatchLogsClient(this._options.awsConfig)
    this._initializing = null
  }

  submit (batch) {
    debug('submit', { batch })
    return this._initialize().then(() => this._doSubmit(batch, 0))
  }

  _initialize () {
    if (this._initializing == null) {
      this._initializing = this._maybeCreateLogGroup()
        .then(() => this._maybeCreateLogStream())
        .catch(err => {
          if (err.code === 'ResourceAlreadyExistsException') { this._maybeCreateLogStream() }
        })
    }
    return this._initializing
  }

  _maybeCreateLogGroup () {
    const { CreateLogGroupCommand } = require('@aws-sdk/client-cloudwatch-logs')

    if (!this._options.createLogGroup) {
      return Promise.resolve()
    }
    const params = {
      logGroupName: this._logGroupName
    }
    const command = new CreateLogGroupCommand(params)
    return this._client.send(command)
    /* return this._client
      .createLogGroup(params)
      .promise()
      .catch(err => this._allowResourceAlreadyExistsException(err)) */
  }

  _maybeCreateLogStream () {
    const {
      CreateLogStreamCommand
    } = require('@aws-sdk/client-cloudwatch-logs')

    if (!this._options.createLogStream) {
      return Promise.resolve()
    }
    const params = {
      logGroupName: this._logGroupName,
      logStreamName: this._logStreamName
    }

    const command = new CreateLogStreamCommand(params)
    return this._client
      .send(command)
      .catch(err => this._allowResourceAlreadyExistsException(err))

    /* return this._client
      .createLogStream(params)
      .promise()
      .catch(err => this._allowResourceAlreadyExistsException(err)) */
  }

  _allowResourceAlreadyExistsException (err) {
    return err.code === 'ResourceAlreadyExistsException'
      ? Promise.resolve()
      : Promise.reject(err)
  }

  _doSubmit (batch, retryCount) {
    return this._maybeUpdateSequenceToken()
      .then(() => this._putLogEventsAndStoreSequenceToken(batch))
      .catch(err => this._handlePutError(err, batch, retryCount))
  }

  _maybeUpdateSequenceToken () {
    return this._sequenceToken != null
      ? Promise.resolve()
      : this._fetchAndStoreSequenceToken()
  }

  _handlePutError (err, batch, retryCount) {
    if (err.code !== 'InvalidSequenceTokenException') {
      return Promise.reject(err)
    }
    if (retryCount >= this._options.submissionRetryCount) {
      const error = new Error('Invalid sequence token, will retry')
      error.code = 'InvalidSequenceTokenException'
      return Promise.reject(error)
    }
    this._sequenceToken = null
    return this._doSubmit(batch, retryCount + 1)
  }

  _putLogEventsAndStoreSequenceToken (batch) {
    return this._putLogEvents(batch).then(({ nextSequenceToken }) =>
      this._storeSequenceToken(nextSequenceToken)
    )
  }

  _putLogEvents (batch) {
    const { PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs')

    const sequenceToken = this._sequenceToken
    debug('putLogEvents', { batch, sequenceToken })
    const params = {
      logGroupName: this._logGroupName,
      logStreamName: this._logStreamName,
      logEvents: batch.map(item => this._formatter.formatLogItem(item)),
      sequenceToken
    }

    const command = new PutLogEventsCommand(params)
    return this._client.send(command)

    // return this._client.putLogEvents(params).promise()
  }

  _fetchAndStoreSequenceToken () {
    debug('fetchSequenceToken')
    return this._findLogStream().then(({ uploadSequenceToken }) =>
      this._storeSequenceToken(uploadSequenceToken)
    )
  }

  _storeSequenceToken (sequenceToken) {
    debug('storeSequenceToken', { sequenceToken })
    this._sequenceToken = sequenceToken
    return sequenceToken
  }

  _findLogStream (nextToken) {
    const {
      DescribeLogStreamsCommand
    } = require('@aws-sdk/client-cloudwatch-logs')

    debug('findLogStream', { nextToken })
    const params = {
      logGroupName: this._logGroupName,
      logStreamNamePrefix: this._logStreamName,
      nextToken
    }

    const command = new DescribeLogStreamsCommand(params)

    return this._client.send(command).then(({ logStreams, nextToken }) => {
      const match = logStreams.find(
        ({ logStreamName }) => logStreamName === this._logStreamName
      )
      if (match) {
        return match
      }
      if (nextToken == null) {
        throw new Error('Log stream not found')
      }
      return this._findLogStream(nextToken)
    })

    /* return this._client
      .describeLogStreams(params)
      .promise()
      .then(({ logStreams, nextToken }) => {
        const match = logStreams.find(
          ({ logStreamName }) => logStreamName === this._logStreamName
        )
        if (match) {
          return match
        }
        if (nextToken == null) {
          throw new Error('Log stream not found')
        }
        return this._findLogStream(nextToken)
      }) */
  }
}

module.exports = CloudWatchClient
