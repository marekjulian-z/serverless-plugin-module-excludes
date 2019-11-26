const _ = require('lodash')
const fs = require('fs')
const madge = require('madge');
const npm = require('npm');
const os = require('os')
const path = require('path');

module.exports = class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.hooks = {
      'before:package:createDeploymentArtifacts': () => this.addExcludeGlobs(),
    };
  }

  async addExcludeGlobs() {
    const { service } = this.serverless;

    service.package = service.package || {};
    service.package.excludeDevDependencies = false

    const fnNames = Object.keys(service.functions)

    for (let i=0; i < fnNames.length; i++) {
      console.log(`processing function: name - ${fnNames[i]}`);
      const fn = service.functions[fnNames[i]]
      const entry = `./${fn.handler.split('.')[0]}.js`
      const include = _.get(service.custom, 'serverless-plugin-module-excludes.include', [])
      const deps = await getExternalDependencies(entry, include)
      const locations = deps.reduce((acc, dep) => ({...acc, [dep]: true}), {})
      const exclude = fs.readdirSync('./node_modules').filter(dirname => !(dirname in locations))
      const globs = exclude.map(location => `node_modules/${location}/**`)

      service.package = service.package || {}
      service.package.exclude = [...(service.package.exclude || []), ...globs]
    }
    console.log(`service package exclude - ${JSON.stringify(service.package.exclude)}`);
  }
};

async function getExternalDependencies(entry, include=[]) {
  const dependencies = await madge(entry, {includeNpm: true}).then((res) => {
    let filenames = Object.keys(res.obj());

    console.log(`external deps - ${filenames}`);
    for (let filename of filenames) {
      console.log(`file deps: filename - ${filename}, deps - ${Object.values(res.obj()[filename])}`);
    }
    return filenames.map(filename => Object.values(res.obj()[filename]))
      .reduce((acc, deps) => acc.concat(deps), []) // flatten
      .filter(dep => /node_modules/.test(dep)) // keep only modules
      .map(dep => dep.match(/node_modules\/([^/]+)\//)[1]) // extract name
      .reduce((acc, deps) => acc[0][deps] ? acc : acc.concat(deps), [{}]).slice(1) // remove dups
  })

  const package = JSON.parse(fs.readFileSync('./package.json'))

  const newPackage = {
    ...package,
    dependencies: dependencies.concat(include).reduce((acc, dep) => {
      if (dep in package.dependencies) {
        acc[dep] = package.dependencies[dep]
      }
      return acc
    }, {}),
    devDependencies: {},
  }

  const tmpDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`)
  fs.writeFileSync(`${tmpDir}${path.sep}package.json`, JSON.stringify(newPackage))

  return new Promise(function(resolve, reject) {
    npm.load({'audit': false, 'dry-run': true, 'only': 'prod'}, function(err) {
      if (err) {
        reject(err)
      } else {
        npm.commands.install(tmpDir, [], function(err, args, res) {
          if (err) {
            reject(err)
          } else {
            resolve(res.children.map(child => child.location.substr(1)))
          }
        })
      }
    })
  })
}
