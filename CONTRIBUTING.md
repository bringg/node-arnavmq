# Contributing Guidlines

## Coding rules
- Our code is currently built around Node v0.12.7, please use nvm to ensure you use the same version.

- Use promises when doing async stuff, based on bluebird library and ensuring it respect the ES6 standards. Once Node.js version is > 0.12.6 on prod env we will drop bluebird.

- Comment your code using the jsdoc standard, version your packages using semver.

- Each feature must be tested by one or more specs, we aim 100% coverage.

- Wrap your code under 100 lines.

- We don’t use tabulation to ident or code, we go for 2 spaces indentation.

## Naming convention
```
var aVariable;
function aFunctionName();
var Object = function() {};
```
Instead of complex inheritance hierarchies, we prefer simple objects. We use prototypal inheritance only when absolutely necessary.

## Jshint
Use the following .jshintrc for your project, it should cover most cases (tests, node, etc.) :
```
{
  "node": true,
  "jasmine": true,
  "mocha": true,
  "curly": false,
  "quotmark": "single",
  "maxcomplexity": 8,
  "unused": true,
  "globals": {
    "after": true,
    "afterEach": true,
    "assert": true,
    "before": true,
    "beforeEach": true,
    "describe": true,
    "expect": true,
    "it": true
  }
}
```

## Git usage guidelines
### Commit messages
Commits must be atomic and commit message must be short and specific. Detailed comments goes after a line break.

### Branch names
Prefix your branch name with the type of modification you are doing.

- feature/my-feature-name
- bugfix/bug-description
- test/my-test-case
- refactor/description
- perf/my-perf-improvement

### Submitting a Pull Request
Contributors must fork the project and create a branch to base your feature on.
```
    $> git checkout -b feature/my-branch develop
```
Make your changes respecting our coding rules, execute tests and when your feature is ready, create your PR on Github on the develop branch.

If all tests passed, congratulations !

