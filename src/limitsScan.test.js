import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLimitsQuery, parseList } from './config.js';
import { reportToCsv, reportToXlsx } from './limitsScan.js';

test('parseList trims comma-separated values', () => {
  assert.deepEqual(parseList(' compute, block-storage ,,vcn '), ['compute', 'block-storage', 'vcn']);
});

test('normalizeLimitsQuery falls back to inferred tenancy as compartment', () => {
  const query = normalizeLimitsQuery({}, {
    tenancyId: '',
    compartmentId: '',
    subscriptionId: 'ocid1.subscription.oc1..example',
    defaults: { regions: 'us-ashburn-1', services: 'compute', limitNames: 'vm-gpu', limitFilter: 'gpu' },
    includeNonReadyRegions: false
  }, 'ocid1.tenancy.oc1..example');

  assert.equal(query.tenancyId, 'ocid1.tenancy.oc1..example');
  assert.equal(query.compartmentId, 'ocid1.tenancy.oc1..example');
  assert.equal(query.subscriptionId, 'ocid1.subscription.oc1..example');
  assert.equal(query.limitFilter, 'gpu');
  assert.equal(query.scanMode, 'full');
  assert.deepEqual(query.regionNames, ['us-ashburn-1']);
  assert.deepEqual(query.serviceNames, ['compute']);
  assert.deepEqual(query.limitNames, ['vm-gpu']);
});

test('normalizeLimitsQuery accepts fast scan mode', () => {
  const query = normalizeLimitsQuery({ scanMode: 'fast' }, {
    tenancyId: 'ocid1.tenancy.oc1..example',
    compartmentId: '',
    subscriptionId: '',
    defaults: { regions: '', services: '', limitNames: '', limitFilter: '', scanMode: 'full' },
    includeNonReadyRegions: false
  });

  assert.equal(query.scanMode, 'fast');
});

test('reportToCsv escapes cells', () => {
  const csv = reportToCsv({
    rows: [{
      regionName: 'us-ashburn-1',
      regionKey: 'IAD',
      regionStatus: 'READY',
      serviceName: 'compute',
      serviceDescription: 'Compute, Bare Metal',
      limitName: 'vm-standard',
      limitDescription: 'Standard virtual machine quota',
      value: 10,
      scopeType: 'AD',
      availabilityDomain: 'qABC:US-ASHBURN-AD-1',
      subscriptionId: '',
      compartmentId: 'ocid1.tenancy.oc1..example'
    }]
  });

  assert.match(csv, /"Compute, Bare Metal"/);
  assert.match(csv, /vm-standard/);
});

test('reportToXlsx returns an Excel workbook payload', () => {
  const workbook = reportToXlsx({
    rows: [{
      regionName: 'us-ashburn-1',
      regionKey: 'IAD',
      regionStatus: 'READY',
      serviceName: 'compute',
      serviceDescription: 'Compute, Bare Metal',
      limitName: 'vm-standard',
      limitDescription: 'Standard virtual machine quota',
      value: 10,
      used: 5,
      available: 5,
      effectiveLimit: 10,
      percentUsed: 50,
      resourceAvailabilitySupported: true,
      usageStatus: 'available',
      usageError: '',
      scopeType: 'AD',
      availabilityDomain: 'qABC:US-ASHBURN-AD-1',
      subscriptionId: '',
      compartmentId: 'ocid1.tenancy.oc1..example'
    }]
  });

  assert.equal(workbook.subarray(0, 2).toString('utf8'), 'PK');
  assert.ok(workbook.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  assert.ok(workbook.includes(Buffer.from('Compute, Bare Metal')));
});
