/**
 * Simple Test Runner
 * 
 * Provides Mocha-like describe/it/beforeEach/afterEach interface
 * for running tests without Mocha dependency.
 */

let passed = 0;
let failed = 0;
let currentSuite = null;
let rootSuites = [];

/**
 * Define a test suite
 */
function describe(name, fn) {
    const suite = {
        name,
        tests: [],
        beforeEach: [],
        afterEach: [],
        beforeAll: [],
        afterAll: [],
        children: [],
        parent: currentSuite
    };
    
    const parentSuite = currentSuite;
    currentSuite = suite;
    
    try {
        fn();
    } finally {
        currentSuite = parentSuite;
    }
    
    if (parentSuite) {
        parentSuite.children.push(suite);
    } else {
        rootSuites.push(suite);
    }
}

/**
 * Define a test case
 */
function it(name, fn) {
    if (!currentSuite) {
        throw new Error('it() must be called inside describe()');
    }
    currentSuite.tests.push({ name, fn });
}

/**
 * Define a hook to run before each test
 */
function beforeEach(fn) {
    if (!currentSuite) {
        throw new Error('beforeEach() must be called inside describe()');
    }
    currentSuite.beforeEach.push(fn);
}

/**
 * Define a hook to run after each test
 */
function afterEach(fn) {
    if (!currentSuite) {
        throw new Error('afterEach() must be called inside describe()');
    }
    currentSuite.afterEach.push(fn);
}

/**
 * Define a hook to run before all tests in a suite
 */
function beforeAll(fn) {
    if (!currentSuite) {
        throw new Error('beforeAll() must be called inside describe()');
    }
    currentSuite.beforeAll.push(fn);
}

/**
 * Define a hook to run after all tests in a suite
 */
function afterAll(fn) {
    if (!currentSuite) {
        throw new Error('afterAll() must be called inside describe()');
    }
    currentSuite.afterAll.push(fn);
}

/**
 * Run a test with done callback support
 */
function runTestWithDone(fn, timeout = 5000) {
    return new Promise((resolve, reject) => {
        let doneCalled = false;
        let timeoutId;
        
        const done = (err) => {
            if (doneCalled) return;
            doneCalled = true;
            clearTimeout(timeoutId);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };
        
        // Set timeout
        timeoutId = setTimeout(() => {
            if (!doneCalled) {
                doneCalled = true;
                reject(new Error(`Test timed out after ${timeout}ms`));
            }
        }, timeout);
        
        try {
            // Check if function expects done callback
            if (fn.length === 1) {
                // Function expects done callback
                fn(done);
            } else {
                // Function is async or sync
                const result = fn();
                if (result && typeof result.then === 'function') {
                    result.then(() => {
                        if (!doneCalled) {
                            done();
                        }
                    }).catch((err) => {
                        if (!doneCalled) {
                            done(err);
                        }
                    });
                } else {
                    // Sync function
                    if (!doneCalled) {
                        done();
                    }
                }
            }
        } catch (err) {
            if (!doneCalled) {
                done(err);
            }
        }
    });
}

/**
 * Get all beforeEach hooks from suite and its parents
 */
function getInheritedBeforeEach(suite) {
    const hooks = [];
    if (suite.parent) {
        hooks.push(...getInheritedBeforeEach(suite.parent));
    }
    hooks.push(...suite.beforeEach);
    return hooks;
}

/**
 * Get all afterEach hooks from suite and its parents (in reverse order)
 */
function getInheritedAfterEach(suite) {
    const hooks = [...suite.afterEach];
    if (suite.parent) {
        hooks.push(...getInheritedAfterEach(suite.parent));
    }
    return hooks;
}

/**
 * Run a suite and its children recursively
 */
async function runSuite(suite, indent = '') {
    const fullName = suite.name;
    console.log(`\n${indent}${fullName}`);
    console.log(`${indent}${'-'.repeat(fullName.length)}`);
    
    // Run beforeAll hooks
    for (const hook of suite.beforeAll) {
        try {
            await runTestWithDone(hook);
        } catch (e) {
            console.log(`${indent}  ✗ beforeAll failed: ${e.message}`);
            failed++;
        }
    }
    
    // Run tests in this suite
    for (const test of suite.tests) {
        // Get all inherited beforeEach hooks
        const beforeEachHooks = getInheritedBeforeEach(suite);
        
        // Run beforeEach hooks
        let hookError = null;
        for (const hook of beforeEachHooks) {
            try {
                await runTestWithDone(hook);
            } catch (e) {
                hookError = e;
                break;
            }
        }
        
        if (hookError) {
            console.log(`${indent}  ✗ "${test.name}" - beforeEach failed: ${hookError.message}`);
            failed++;
            continue;
        }
        
        // Run test
        try {
            await runTestWithDone(test.fn);
            console.log(`${indent}  ✓ ${test.name}`);
            passed++;
        } catch (e) {
            console.log(`${indent}  ✗ ${test.name}`);
            console.log(`${indent}    Error: ${e.message}`);
            if (e.stack) {
                const stackLines = e.stack.split('\n').slice(1, 3);
                stackLines.forEach(line => console.log(`${indent}    ${line.trim()}`));
            }
            failed++;
        }
        
        // Get all inherited afterEach hooks
        const afterEachHooks = getInheritedAfterEach(suite);
        
        // Run afterEach hooks
        for (const hook of afterEachHooks) {
            try {
                await runTestWithDone(hook);
            } catch (e) {
                console.log(`${indent}  ⚠ afterEach failed: ${e.message}`);
            }
        }
    }
    
    // Run afterAll hooks
    for (const hook of suite.afterAll) {
        try {
            await runTestWithDone(hook);
        } catch (e) {
            console.log(`${indent}  ⚠ afterAll failed: ${e.message}`);
        }
    }
    
    // Run child suites
    for (const child of suite.children) {
        await runSuite(child, indent);
    }
}

/**
 * Run all registered test suites
 */
async function runTests() {
    console.log('\n=== Running Tests ===');
    
    for (const suite of rootSuites) {
        await runSuite(suite);
    }
    
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    
    return { passed, failed };
}

/**
 * Run tests and exit with appropriate code
 */
async function runAndExit() {
    try {
        const { passed, failed } = await runTests();
        process.exit(failed > 0 ? 1 : 0);
    } catch (e) {
        console.error('Test runner error:', e);
        process.exit(1);
    }
}

module.exports = {
    describe,
    it,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
    runTests,
    runAndExit
};
