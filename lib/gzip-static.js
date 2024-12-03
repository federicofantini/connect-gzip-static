const fs = require('node:fs/promises');
const path = require('node:path');
const send = require('send');
const debug = require('debug')('connect:gzip-static');
const parseUrl = require('parseurl');
const mime = require('mime-types');

function setHeader(res, path, encoding) {
  const type = mime.lookup(path);
  const charset = mime.charset(type);

  debug('content-type %s', type);
  res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Vary', 'Accept-Encoding');
}

/**
 * Creates cache of filenames matching the regex
 * @param {String} root
 * @param {RegExp} regex
 * @returns newly create cache
 */
async function createCache(root, regex) {
  const files = await fs.readdir(root, { recursive: true });
  const entries = files
    .filter(n => regex.test(n))
    .map(n => path.resolve(root, n));
  debug('Found %d compressed files', entries.length);
  return new Set(entries);
}

async function createMethods(root) {
  return [
    { extension: '.br', encoding: 'br', cache: await createCache(root, /\.br$/) },
    { extension: '.gz', encoding: 'gzip', cache: await createCache(root, /\.gz$/) },
  ];
}

module.exports = function (root, options = {}) {
  const methodsPromise = createMethods(root);

  options.index ||= 'index.html'; // jshint ignore:line

  const setHeaders = options.setHeaders;
  const serveStatic = require('serve-static')(root, options);

  return async function gzipStatic(req, res, next) {
    if ('GET' != req.method && 'HEAD' != req.method) {
      return next();
    }

    let name;

    checking: {
      for (const method of await methodsPromise) {
        name = check(req, method);
        if (name) {
          break checking;
        }
      }
      debug('Passing %s', req.url);
      return serveStatic(req, res, next);
    }

    debug('Sending %s', name.full);
    setHeader(res, name.orig, name.encoding);

    const stream = send(req, name.compressed, {
      maxAge: options.maxAge || 0,
      root,
      index: name.index,
      cacheControl: options.cacheControl,
      lastModified: options.lastModified,
      etag: options.etag,
      dotfiles: options.dotfiles
    })
      .on('error', next);

    if (setHeaders) {
      stream.on('headers', setHeaders);
    }
    stream.pipe(res);
  };

  function check(req, { encoding, extension, cache }) {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes(encoding)) {
      return;
    }

    const name = {
      orig: parseUrl(req).pathname,
      encoding
    };

    if (name.orig.at(-1) === '/') {
      name.compressed = name.orig;
      name.orig += options.index;
      name.index = options.index + extension;
    } else {
      name.compressed = name.orig + extension;
    }
    name.full = path.join(root, name.orig + extension);
    debug('request %s, check for %s', req.url, name.full);

    if (cache.has(name.full)) {
      return name;
    }
  }
};
