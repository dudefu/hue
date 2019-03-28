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

import $ from 'jquery';
import ko from 'knockout';

import hueUtils from 'utils/hueUtils';

const adaptMeta = meta => {
  meta.forEach((item, index) => {
    if (typeof item.checked === 'undefined') {
      item.checked = ko.observable(true);
      item.checked.subscribe(() => {
        self.filteredMetaChecked(
          self.filteredMeta().some(item => {
            return item.checked();
          })
        );
      });
    }
    item.type = item.type.replace(/_type/i, '').toLowerCase();
    if (typeof item.originalIndex === 'undefined') {
      item.originalIndex = index;
    }
  });
};

const isNumericColumn = type =>
  ['tinyint', 'smallint', 'int', 'bigint', 'float', 'double', 'decimal', 'real'].indexOf(type) !==
  -1;

const isDateTimeColumn = type => ['timestamp', 'date', 'datetime'].indexOf(type) !== -1;

const isComplexColumn = type => ['array', 'map', 'struct'].indexOf(type) !== -1;

const isStringColumn = type =>
  !isNumericColumn(type) && !isDateTimeColumn(type) && !isComplexColumn(type);

class Result {
  constructor(snippet, result) {
    const self = this;

    $.extend(
      snippet,
      snippet.chartType === 'lines' && {
        // Retire line chart
        chartType: 'bars',
        chartTimelineType: 'line'
      }
    );
    self.id = ko.observable(result.id || hueUtils.UUID());
    self.type = ko.observable(result.type || 'table');
    self.hasResultset = ko.observable(result.hasResultset !== false).extend('throttle', 100);
    self.handle = ko.observable(result.handle || {});
    self.meta = ko.observableArray(result.meta || []);

    adaptMeta(self.meta());
    self.meta.subscribe(() => {
      adaptMeta(self.meta());
    });

    self.rows = ko.observable(result.rows);
    self.hasMore = ko.observable(!!result.hasMore);
    self.statement_id = ko.observable(result.statement_id || 0);
    self.statement_range = ko.observable(
      result.statement_range || {
        start: {
          row: 0,
          column: 0
        },
        end: {
          row: 0,
          column: 0
        }
      }
    );
    // We don't keep track of any previous selection so prevent entering into batch execution mode after load by setting
    // statements_count to 1. For the case when a selection is not starting at row 0.
    self.statements_count = ko.observable(1);
    self.previous_statement_hash = ko.observable(result.previous_statement_hash);
    self.cleanedMeta = ko.pureComputed(() => self.meta().filter(item => item.name !== ''));
    self.metaFilter = ko.observable();

    self.isMetaFilterVisible = ko.observable(false);
    self.filteredMetaChecked = ko.observable(true);
    self.filteredMeta = ko.pureComputed(() => {
      if (!self.metaFilter() || self.metaFilter().query === '') {
        return self.meta();
      }

      return self.meta().filter(item => {
        const facets = self.metaFilter().facets;
        const isFacetMatch = !facets || Object.keys(facets).length === 0 || !facets['type']; // So far only type facet is used for SQL
        const isTextMatch = !self.metaFilter().text || self.metaFilter().text.length === 0;
        let match = true;

        if (!isFacetMatch) {
          match = !!facets['type'][item.type];
        }

        if (match && !isTextMatch) {
          match = self.metaFilter().text.every(text => {
            return item.name.toLowerCase().indexOf(text.toLowerCase()) !== -1;
          });
        }
        return match;
      });
    });

    self.fetchedOnce = ko.observable(!!result.fetchedOnce);
    self.startTime = ko.observable(result.startTime ? new Date(result.startTime) : new Date());
    self.endTime = ko.observable(result.endTime ? new Date(result.endTime) : new Date());
    self.executionTime = ko.pureComputed(
      () => self.endTime().getTime() - self.startTime().getTime()
    );

    self.cleanedNumericMeta = ko.pureComputed(() =>
      self.meta().filter(item => item.name !== '' && isNumericColumn(item.type))
    );
    self.cleanedStringMeta = ko.pureComputed(() =>
      self.meta().filter(item => item.name !== '' && isStringColumn(item.type))
    );
    self.cleanedDateTimeMeta = ko.pureComputed(() =>
      self.meta().filter(item => item.name !== '' && isDateTimeColumn(item.type))
    );

    self.data = ko.observableArray(result.data || []).extend({ rateLimit: 50 });
    self.explanation = ko.observable(result.explanation || '');
    self.images = ko.observableArray(result.images || []).extend({ rateLimit: 50 });
    self.logs = ko.observable('');
    self.logLines = 0;
    self.hasSomeResults = ko.pureComputed(() => self.hasResultset() && self.data().length > 0);
  }

  autocompleteFromEntries(nonPartial, partial) {
    const self = this;
    const result = [];
    const partialLower = partial.toLowerCase();
    self.meta().forEach(column => {
      if (column.name.toLowerCase().indexOf(partialLower) === 0) {
        result.push(nonPartial + partial + column.name.substring(partial.length));
      } else if (column.name.toLowerCase().indexOf('.' + partialLower) !== -1) {
        result.push(
          nonPartial +
            partial +
            column.name.substring(
              partial.length + column.name.toLowerCase().indexOf('.' + partialLower) + 1
            )
        );
      }
    });

    return result;
  }

  cancelBatchExecution() {
    const self = this;
    self.statements_count(1);
    self.hasMore(false);
    self.statement_range({
      start: {
        row: 0,
        column: 0
      },
      end: {
        row: 0,
        column: 0
      }
    });
    self.handle()['statement_id'] = 0;
    self.handle()['start'] = {
      row: 0,
      column: 0
    };
    self.handle()['end'] = {
      row: 0,
      column: 0
    };
    self.handle()['has_more_statements'] = false;
    self.handle()['previous_statement_hash'] = '';
  }

  clear() {
    const self = this;
    self.fetchedOnce(false);
    self.hasMore(false);
    self.statement_range({
      start: {
        row: 0,
        column: 0
      },
      end: {
        row: 0,
        column: 0
      }
    });
    self.meta.removeAll();
    self.data.removeAll();
    self.images.removeAll();
    self.logs('');
    self.handle({
      // Keep multiquery indexing
      has_more_statements: self.handle()['has_more_statements'],
      statement_id: self.handle()['statement_id'],
      statements_count: self.handle()['statements_count'],
      previous_statement_hash: self.handle()['previous_statement_hash']
    });
    self.startTime(new Date());
    self.endTime(new Date());
    self.explanation('');
    self.logLines = 0;
    self.rows(null);
  }

  clickFilteredMetaCheck() {
    const self = this;
    self.filteredMeta().forEach(item => {
      item.checked(self.filteredMetaChecked());
    });
  }

  getContext() {
    const self = this;
    return {
      id: self.id,
      type: self.type,
      handle: self.handle
    };
  }
}

export default Result;
