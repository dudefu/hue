// Licensed to Cloudera, Inc. under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  Cloudera, Inc. licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import CancellablePromise from 'api/cancellablePromise';
import { STATUS, ExecutableStatement } from './executableStatement';
import sqlStatementsParser from 'parse/sqlStatementsParser';

const EXECUTION_FLOW = {
  step: 'step',
  batch: 'batch',
  // batchNoBreak: 'batchNoBreak'
};

const BATCHABLE_STATEMENT_TYPES = /ALTER|CREATE|DELETE|DROP|GRANT|INSERT|INVALIDATE|LOAD|SET|TRUNCATE|UPDATE|UPSERT|USE/i;

class Executor {

  /**
   * @param options
   * @param {boolean} [options.isSqlEngine] (default false)
   * @param {string} options.sourceType
   * @param {ContextCompute} options.compute
   * @param {ContextNamespace} options.namespace
   * @param {EXECUTION_FLOW} [options.executionFlow] (default EXECUTION_FLOW.batch)
   * @param {string} options.statement
   * @param {string} [options.database]
   */
  constructor(options) {
    this.sourceType = options.sourceType;
    this.compute = options.compute;
    this.namespace = options.namespace;
    this.database = options.database;
    this.isSqlEngine = options.isSqlEngine;
    this.executionFlow = this.isSqlEngine ? options.executionFlow || EXECUTION_FLOW.batch : EXECUTION_FLOW.step;

    this.toExecute = [];
    this.currentExecutable = undefined;
    this.executed = [];

    if (this.isSqlEngine) {
      let database = options.database;
      sqlStatementsParser.parse(options.statement).forEach(parsedStatement => {
        // If there's no first token it's a trailing comment
        if (parsedStatement.firstToken) {

          // TODO: Do we want to send USE statements separately or do we want to send database as param instead?
          if (/USE/i.test(parsedStatement.firstToken)) {
            let dbMatch = parsedStatement.statement.match(/use\s+([^;]+)/i);
            if (dbMatch) {
              database = dbMatch[1];
            }
          } else {
            this.toExecute.push(new ExecutableStatement({
              sourceType: options.sourceType,
              compute: options.compute,
              namespace: options.namespace,
              database: database,
              parsedStatement: parsedStatement
            }));
          }
        }
      });
    } else {
      this.toExecute.push(new ExecutableStatement(options));
    }

    this.status = STATUS.ready;
  }

  async cancel() {
    if (this.currentExecutable && this.currentExecutable.status === STATUS.running) {
      this.status = STATUS.canceling;
      return await this.currentExecutable.cancel();
    }
  }

  async executeNext() {
    return new Promise((resolve, reject) => {
      if (this.currentExecutable) {
        if (this.currentExecutable.status === STATUS.running) {
          reject();
        }
        if (this.currentExecutable.status === STATUS.success) {
          this.executed.push(this.currentExecutable);
          this.currentExecutable = undefined;
        }
      }

      if (!this.currentExecutable) {
        if (this.toExecute.length === 0) {
          resolve();
        } else {
          this.currentExecutable = this.toExecute.shift();
        }
      }

      if (this.currentExecutable) {
        this.status = STATUS.running;
        this.currentExecutable.execute().then(() => {
          if (this.canExecuteNextInBatch()) {
            this.executeNext().then(resolve).catch(reject);
          } else {
            // this.status = STATUS.paused
          }
        })
      }
    })
  }

  canExecuteNextInBatch() {
    return this.isSqlEngine && this.executionFlow !== EXECUTION_FLOW.step && this.currentExecutable && this.currentExecutable.parsedStatement && BATCHABLE_STATEMENT_TYPES.test(this.currentExecutable.parsedStatement.firstToken)
  }
}

export default Executor;