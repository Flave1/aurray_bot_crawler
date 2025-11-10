const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlatformController, PLATFORM_REGISTRY } = require('../platforms');

function createStubLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };
}

function createStubPage() {
  return {
    locator() {
      return {
        first() {
          return {
            async waitFor() { return this; },
            async isVisible() { return false; },
            async getAttribute() { return null; },
            async textContent() { return ''; },
            async click() {},
            async evaluate() { return null; }
          };
        },
        async all() { return []; }
      };
    },
    context() {
      return {
        async grantPermissions() {}
      };
    },
    isClosed() {
      return false;
    }
  };
}

test('createPlatformController returns controller for each registered platform', () => {
  const platforms = Object.keys(PLATFORM_REGISTRY);
  const stubPage = createStubPage();
  const stubConfig = { joinTimeoutSec: 1 };
  const stubLogger = createStubLogger();

  platforms.forEach((platformKey) => {
    const controller = createPlatformController(platformKey, stubPage, stubConfig, stubLogger);
    assert.ok(controller, `Controller should be created for ${platformKey}`);
    assert.equal(
      controller.constructor,
      PLATFORM_REGISTRY[platformKey],
      `Expected controller for ${platformKey} to match registry`
    );
  });
});

test('createPlatformController throws for unsupported platform', () => {
  assert.throws(
    () => createPlatformController('unsupported', createStubPage(), {}, createStubLogger()),
    /Unsupported meeting platform/
  );
});
