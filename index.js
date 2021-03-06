var path = require('path');
var fs = require('fs');
var crypto = require('crypto');

var mime = require('mime');
var uglifyjs = require('uglify-js');
var browserify = require('browserify');
var debug = require('debug')('enchilada');

var watcher = require('./watcher')

module.exports = function enchilada(opt) {

    // if just a path is passed in, treat as public file dir
    if (typeof opt === 'string') {
        opt = { src: opt };
    }

    var pubdir = opt.src;
    var routes = opt.routes || {};
    var bundles = {};

    var compress = false || opt.compress;
    var cache = {};
    var debug_opt = false || opt.debug;

    var watch = !opt.cache;
    var watchCallback = opt.watchCallback;

    function makeBundle(options) {
        var bundle = browserify(options);
        if (opt.transforms) {
            opt.transforms.forEach(bundle.transform.bind(bundle));
        }
        if (opt.externals) {
            opt.externals.forEach(function(external) {
                bundle.external(external);
            });
        }
        return bundle;
    }

    // TODO(shtylman) externs that use other externs?
    Object.keys(routes).map(function(id) {
        var name = routes[id];

        debug('route: %s -> %s', id, name);

        var bundle = makeBundle({ exposeAll: true });
        bundle.require(name, { entry: true, expose: name, basedir: pubdir });
        return bundles[id] = bundle;
    });

    return function(req, res, next) {
        var req_path = req.path;

        // if no extension, then don't process
        // handles case of directories and other random urls
        if (!path.extname(req_path)) {
            return next();
        }
        else if (mime.lookup(req_path) !== 'application/javascript') {
            return next();
        }

        // check cache
        var cached = cache[req_path];
        if (cached) {
            return sendResponse(null, cached);
        }

        // check for bundle
        var bundle = bundles[req_path];
        if (bundle) {
            return generate(bundle, sendResponse);
        }

        var local_file = path.normalize(path.join(pubdir, req_path));

        // check for malicious attempts to access outside of pubdir
        if (local_file.indexOf(pubdir) !== 0) {
            return next();
        }

        debug('bundling %s', local_file);

        // lookup in filesystem
        fs.exists(local_file, function(exists) {
            if (!exists) {
                return next();
            }

            var bundle = makeBundle(local_file);
            Object.keys(bundles).forEach(function(id) {
                bundle.external(bundles[id]);
            });
            generate(bundle, sendResponse);
        });

        function generate(bundle, callback) {
            var dependencies = {};

            // typically SyntaxError
            var otherError;
            bundle.once('error', function(err) { otherError = err; });

            var collect_deps = function(file) {
                dependencies[file] = true;
            };

            if (watch) {
                bundle.on('file', collect_deps);
            }

            bundle.bundle({ debug: debug_opt }, function(err, src) {
                bundle.removeListener('file', collect_deps);

                if (watch) {
                    watchFiles(bundle, dependencies, req_path);
                }
                if (err) {
                    return callback(err);
                }
                if (otherError) {
                    return callback(otherError);
                }
                if (compress) {
                    var result = uglifyjs.minify(src, {
                        fromString: true
                    });

                    src = result.code;
                }
                cache[req_path] = src;

                callback(null, src);
            });
        }

        function sendResponse(err, src) {
            if (err) {
                return next(err);
            }
            res.contentType('application/javascript');
            res.header('ETag', crypto.createHash('md5').update(src).digest('hex').slice(0, 6));
            res.header('Vary', 'Accept-Encoding');
            res.send(src);
        }

        function watchFiles(bundle, dependencies, path) {
            var watchers = Object.keys(dependencies).map(function(filename) {
                return watcher(filename, function() {
                    delete cache[path];
                    generate(bundle, function(error) {
                        watchCallback && watchCallback(error, path);
                    });
                    watchers.forEach(function(watcher) {
                        watcher.close();
                    });
                });
            });
        }
    };
};

