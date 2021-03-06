"use strict";

// Copy from electrode-react-webapp for now

/* eslint-disable max-statements, complexity, global-require, no-magic-numbers, no-console */

const _ = require("lodash");
const Fs = require("fs");
const Path = require("path");
const assert = require("assert");
const Url = require("url");
const util = require("util");
const optionalRequire = require("optional-require")(require);
const scanDir = require("filter-scan-dir");
const Boom = require("@hapi/boom");
const HttpStatus = require("./http-status");
const readFile = util.promisify(Fs.readFile);
const xaa = require("xaa");
const { ReactWebapp } = require("electrode-react-webapp");
const subAppUtil = require("subapp-util");
const registerRoutes = require("./register-routes");

const { resolveChunkSelector, getDefaultRouteOptions, updateFullTemplate } = require("./utils");

async function searchRoutesDir(srcDir, pluginOpts) {
  const { loadRoutesFrom } = pluginOpts;

  const routesDir = [
    loadRoutesFrom && Path.resolve(srcDir, loadRoutesFrom),
    Path.resolve(srcDir, "routes"),
    Path.resolve(srcDir, "server", "routes"),
    Path.resolve(srcDir, "server-routes")
  ].find(x => x && Fs.existsSync(x) && Fs.statSync(x).isDirectory());

  // there's no routes, server/routes, or server-routes dir
  if (!routesDir) {
    return undefined;
  }

  //
  // look for routes under routesDir
  // - each dir inside is considered to be a route with name being the dir name
  //
  const dirs = await scanDir({ dir: routesDir, includeRoot: true, filter: f => f === "route.js" });

  //
  // load options for all routes from routesDir/options.js[x]
  //
  const options = optionalRequire(Path.join(routesDir, "options"), { default: {} });

  //
  // Generate routes: load the route.js file for each route
  //
  const routes = dirs.map(x => {
    const name = Path.dirname(x.substring(routesDir.length + 1));
    const route = Object.assign({}, require(x));
    _.defaults(route, {
      // the route dir that's named default is /
      path: name === "default" && "/",
      methods: options.methods || ["get"]
    });

    assert(route.path, `subapp-server: route ${name} must define a path`);

    return {
      name,
      dir: Path.dirname(x),
      route
    };
  });

  return { options, dir: routesDir, routes };
}

async function handleFavIcon(server, options) {
  //
  // favicon handling, turn off by setting options.favicon to false
  //
  if (options.favicon === false) {
    return;
  }

  // look in CWD/static
  const iconFile = Path.resolve(options.favicon || "static/favicon.ico");
  const icon = await xaa.try(() => readFile(iconFile));

  server.route({
    method: "get",
    path: "/favicon.ico",
    async handler() {
      if (icon) return icon;
      else return Boom.notFound();
    }
  });
}

async function setupRoutesFromFile(srcDir, server, pluginOpts) {
  // there should be a src/routes.js file with routes spec
  const { loadRoutesFrom } = pluginOpts;

  const routesFile = [
    loadRoutesFrom && Path.resolve(srcDir, loadRoutesFrom),
    Path.resolve(srcDir, "routes")
  ].find(x => x && optionalRequire(x));

  const spec = routesFile ? require(routesFile) : {};

  const subApps = await subAppUtil.scanSubAppsFromDir(srcDir);
  const subAppsByPath = subAppUtil.getSubAppByPathMap(subApps);

  const topOpts = _.merge(
    getDefaultRouteOptions(),
    { dir: Path.resolve(srcDir) },
    _.omit(spec, ["routes", "default"]),
    pluginOpts
  );

  topOpts.routes = _.merge({}, spec.routes || spec.default, topOpts.routes);

  await handleFavIcon(server, topOpts);

  // routes can either be in default (es6) or routes
  const routes = topOpts.routes;

  // invoke setup callback
  for (const path in routes) {
    if (routes[path].setup) {
      await routes[path].setup(server);
    }
  }

  // setup for initialize callback
  server.ext("onPreAuth", async (request, h) => {
    const rte = routes[request.route.path];
    if (rte && rte.initialize) {
      const x = await rte.initialize(request, h);
      if (x) return x;
    }
    return h.continue;
  });

  topOpts.devBundleBase = Url.format({
    protocol: topOpts.devServer.https ? "https" : "http",
    hostname: topOpts.devServer.host,
    port: topOpts.devServer.port,
    pathname: "/js/"
  });

  // register routes

  for (const path in routes) {
    const route = routes[path];

    const routeOptions = Object.assign({}, topOpts, route);
    updateFullTemplate(routeOptions.dir, routeOptions);
    const chunkSelector = resolveChunkSelector(routeOptions);
    routeOptions.__internals = { chunkSelector };

    // load subapps for the route
    if (routeOptions.subApps) {
      routeOptions.__internals.subApps = [].concat(routeOptions.subApps).map(x => {
        let options = {};
        if (Array.isArray(x)) {
          options = x[1];
          x = x[0];
        }
        // absolute: use as path
        // else: assume dir under srcDir
        // TBD: handle it being a module
        return {
          subapp: subAppsByPath[Path.isAbsolute(x) ? x : Path.resolve(srcDir, x)],
          options
        };
      });
    }

    const routeHandler = ReactWebapp.makeRouteHandler(routeOptions);
    const handler = async (request, h) => {
      try {
        const context = await routeHandler({
          content: { html: "", status: 200, useStream: true },
          mode: "",
          request
        });

        const data = context.result;
        const status = data.status;

        if (data instanceof Error) {
          // rethrow to get default error behavior below with helpful errors in dev mode
          throw data;
        } else if (status === undefined) {
          return h
            .response(data)
            .type("text/html; charset=UTF-8")
            .code(200);
        } else if (HttpStatus.redirect[status]) {
          return h.redirect(data.path);
        } else if (HttpStatus.displayHtml[status]) {
          return h.response(data.html !== undefined ? data.html : data).code(status);
        } else if (status >= 200 && status < 300) {
          return data.html !== undefined ? data.html : data;
        } else {
          return h.response(data).code(status);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.error(`Route ${path} failed:`, err);
          return err.stack;
        } else {
          return Boom.internal();
        }
      }
    };

    const defaultMethods = [].concat(route.methods || "get");
    const paths = _.uniq([path].concat(route.paths).filter(x => x)).map(x => {
      if (typeof x === "string") {
        return { [x]: defaultMethods };
      }
      return x;
    });

    paths.forEach(pathObj => {
      _.each(pathObj, (method, xpath) => {
        server.route(Object.assign({}, route.options, { path: xpath, method, handler }));
      });
    });
  }
}

async function setupRoutesFromDir(server, pluginOpts, fromDir) {
  const { routes } = fromDir;

  const topOpts = _.merge(getDefaultRouteOptions(), fromDir.options, pluginOpts);

  topOpts.routes = _.merge({}, routes, topOpts.routes);

  updateFullTemplate(fromDir.dir, topOpts);

  const routesWithSetup = routes.filter(x => x.route.setup);

  for (const route of routesWithSetup) {
    await route.route.setup(server);
  }

  await handleFavIcon(server, topOpts);

  // register onRequest
  const routesWithInit = routes.filter(x => x.route.initialize);
  if (routesWithInit.length > 0) {
    server.ext("onPreAuth", async (request, h) => {
      const rte = routes[request.route.path];
      if (rte && rte.initialize) {
        const x = await rte.initialize(request, h);
        if (x) return x;
      }
      return h.continue;
    });
  }

  topOpts.devBundleBase = Url.format({
    protocol: topOpts.devServer.https ? "https" : "http",
    hostname: topOpts.devServer.host,
    port: topOpts.devServer.port,
    pathname: "/js/"
  });

  registerRoutes({ routes, topOpts, server });
}

async function setupSubAppHapiRoutes(server, pluginOpts) {
  const srcDir =
    pluginOpts.srcDir ||
    process.env.APP_SRC_DIR ||
    (process.env.NODE_ENV === "production" ? "lib" : "src");

  const fromDir = await searchRoutesDir(srcDir, pluginOpts);
  if (fromDir) {
    return await setupRoutesFromDir(server, pluginOpts, fromDir);
  }

  // no directory based routes, then they must in a JS file
  return await xaa.try(() => setupRoutesFromFile(srcDir, server, pluginOpts));
}

module.exports = {
  setupSubAppHapiRoutes
};
