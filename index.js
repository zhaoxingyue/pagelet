'use strict';

var debug = require('debug')('bigpipe:pagelet')
  , FreeList = require('freelist').FreeList
  , fuse = require('fusing')
  , path = require('path')
  , fs = require('fs');

/**
 * A pagelet is the representation of an item, section, column, widget on the
 * page. It's basically a small sandboxed application within your page.
 *
 * @constructor
 * @api public
 */
function Pagelet() {
  var writable = Pagelet.predefine(this, Pagelet.predefine.WRITABLE);

  //
  // Custom ID of the pagelet.
  //
  writable('id', null);

  //
  // Prepare the instance.
  //
  this.configure();
}

fuse(Pagelet, require('stream'));

/**
 * The name of this pagelet so it can checked to see if's enabled. In addition
 * to that, it can be injected in to placeholders using this name.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('name', '');

/**
 * These methods can be remotely called from the client. Please note that they
 * are not set to the client, it will merely be executing on the server side.
 *
 * ```js
 * Pagelet.extend({
 *   RPC: [
 *     'methodname',
 *     'another'
 *   ],
 *
 *   methodname: function methodname(reply) {
 *
 *   }
 * }).on(module);
 * ```
 *
 * @type {Array}
 * @public
 */
Pagelet.writable('RPC', []);

/**
 * An authorization handler to see if the request is authorized to interact with
 * this pagelet. This is set to `null` by default as there isn't any
 * authorization in place. The authorization function will receive 2 arguments:
 *
 * - req, the http request that initialized the pagelet
 * - done, a callback function that needs to be called with only a boolean.
 *
 * ```js
 * Pagelet.extend({
 *   authorize: function authorize(req, done) {
 *     done(true); // True indicates that the request is authorized for access.
 *   }
 * });
 * ```
 *
 * @type {Function}
 * @public
 */
Pagelet.writable('authorize', null);

/**
 * The actual chunk of the response that is written for each pagelet.
 *
 * @type {String}
 * @private
 */
Pagelet.writable('fragment', fs.readFileSync(__dirname +'/pagelet.fragment', 'utf-8')
  .split('\n')
  .join('')
);

/**
 * Remove the DOM element if we are unauthorized. This will make it easier to
 * create conditional layouts without having to manage the pointless DOM
 * elements.
 *
 * @type {Boolean}
 * @public
 */
Pagelet.writable('remove', true);

/**
 * The location of your view template. But just because you've got a view
 * template it doesn't mean we will render it. It depends on how the pagelet is
 * called. If it's called from the client side we will only forward the data to
 * server.
 *
 * As a user you need to make sure that your template runs on the client as well
 * as on the server side.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('view', '');

/**
 * The location of your error template. This template will be rendered when:
 *
 * 1. We receive an `error` argument from your `render` method.
 * 2. Your view throws an error when rendering the template.
 *
 * If no view has been set it will default to the Pagelet's default error
 * template which outputs a small HTML fragrment that states the error.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('error', '');

/**
 * Optional template engine preference. Useful when we detect the wrong template
 * engine based on the view's file name.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('engine', '');

/**
 * The location of the Style Sheet for this pagelet. It should contain all the
 * CSS that's needed to render this pagelet. It doesn't have to be a `CSS`
 * extension as these files are passed through `smithy` for automatic
 * pre-processing.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('css', '');

/**
 * The location of the JavaScript file that you need for this page. This file
 * needs to be included in order for this pagelet to function.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('js', '');

/**
 * An array with dependencies that your pagelet depends on. This can be CSS or
 * JavaScript files/frameworks whatever. It should be an array of strings
 * which represent the location of these files.
 *
 * @type {Array}
 * @public
 */
Pagelet.writable('dependencies', []);

/**
 * Save the location where we got our resources from, this will help us with
 * fetching assets from the correct location.
 *
 * @type {String}
 * @public
 */
Pagelet.writable('directory', '');

/**
 * Default asynchronous render function.
 *
 * @type {Function}
 * @api public
 */
Pagelet.writable('render', function render(done) {
  setImmediate(done);
});

//
// !IMPORTANT
//
// These function's & properties should never overridden as we might depend on
// them internally, that's why they are configured with writable: false and
// configurable: false by default.
//
// !IMPORTANT
//

/**
 * Renderer takes care of all the data merging and `render` invocation.
 *
 * @param {Temper} temper Custom Temper instance.
 * @param {Function} after Post render function.
 * @param {Function} fn Completion callback.
 * @api private
 */
Pagelet.readable('renderer', function renderer(temper, after, fn) {
  var pagelet = this
    , view = temper.fetch(this.view).server
    , content;

  this.render(function receive(err, data) {
    if (err) debug('rendering %s/%s resulted in a error', pagelet.name, pagelet.id, err);

    //
    // We've made it this far, but now we have to cross our fingers and HOPE that
    // our given template can actually handle the data correctly without throwing
    // an error. As the rendering is done synchronously, we wrap it in a try/catch
    // statement and hope that an error is thrown when the template fails to
    // render the content. If there's an error we will process the error template
    // instead.
    //
    try {
      content = view(data);
    } catch (e) {
      //
      // This is basically fly or die, if the supplied error template throws an
      // error while rendering we're basically fucked, your server will crash,
      // an angry mob of customers with pitchforks will kick in the doors of your
      // office and smear you with peck and feathers for not writing a more stable
      // application.
      //
      if (!pagelet.error) throw e;

      content = this.temper.fetch(pagelet.error).server(this.merge(data, {
        reason: 'Failed to render '+ pagelet.name +' as the template throws an error',
        message: e.message,
        stack: e.stack
      }));
    }

    after(pagelet, content, fn);
  });
});

/**
 * Reset the instance to it's original state.
 *
 * @api private
 */
Pagelet.readable('configure', function configure() {
  //
  // Set a new id.
  //
  this.id = [1, 1, 1, 1].map(function generator() {
    return Math.random().toString(36).substring(2).toUpperCase();
  }).join('-');

  debug('configuring %s/%s', this.name, this.id);
  return this.removeAllListeners();
});

/**
 * Trigger a RPC function.
 *
 * @param {String} method The name of the method.
 * @param {Array} args The function arguments.
 * @param {String} id The RPC id.
 * @param {SubStream} substream The substream that does RPC.
 * @returns {Boolean} The event was triggered.
 * @api private
 */
Pagelet.readable('trigger', function trigger(method, args, id, substream) {
  var index = this.RPC.indexOf(method)
    , err;

  if (!~index) {
    debug('%s/%s received an unknown method `%s`, ignorning rpc', this.name, this.id, method);
    return substream.write({
      args: [new Error('The given method is not allowed as RPC function.')],
      type: 'rpc',
      id: id
    });
  }

  var fn = this[this.RPC[index]]
    , pagelet = this;

  if ('function' !== typeof fn) {
    debug('%s/%s method `%s` is not a function, ignoring rpc', this.name, this.id, method);
    return substream.write({
      args: [new Error('The called method is not an RPC function.')],
      type: 'rpc',
      id: id
    });
  }

  //
  // We've found a working function, assume that function is RPC compatible
  // where it accepts a `returns` function that receives the arguments.
  //
  fn.apply(this, [function returns() {
    var args = Array.prototype.slice.call(arguments, 0)
      , success = substream.write({ type: 'rpc', args: args, id: id });

    return success;
  }].concat(args));

  return true;
});

/**
 * Expose the Pagelet on the exports and parse our the directory. This ensures
 * that we can properly resolve all relative assets:
 *
 * ```js
 * Pagelet.extend({
 *   ..
 * }).on(module);
 * ```
 *
 * @param {Module} module The reference to the module object.
 * @api public
 */
Pagelet.on = function on(module) {
  this.prototype.directory = this.prototype.directory || path.dirname(module.filename);
  module.exports = this;

  return this;
};

/**
 * Optimize the prototypes of the Pagelet to reduce work when we're actually
 * serving the requests.
 *
 * @param {Temper} temper Custom Temper instance.
 * @param {Function} hook Hook into optimize, function will be called with Pagelet.
 * @api private
 */
Pagelet.optimize = function optimize(temper, hook) {
  var Pagelet = this
    , prototype = Pagelet.prototype
    , dir = prototype.directory;

  //
  // This pagelet has already been processed before as pages can share
  // pagelets.
  //
  if (Pagelet.properties) return Pagelet;

  if (prototype.view) {
    Pagelet.prototype.view = path.resolve(dir, prototype.view);
    temper.prefetch(Pagelet.prototype.view, Pagelet.prototype.engine);
  }

  //
  // Ensure that we have a custom error page for when we fail to render this
  // fragment.
  //
  if (prototype.error) {
    Pagelet.prototype.error = path.resolve(dir, prototype.error);
    temper.prefetch(Pagelet.prototype.error, Pagelet.prototype.engine);
  } else {
    Pagelet.prototype.error = path.resolve(__dirname, 'error.ejs');
    temper.prefetch(Pagelet.prototype.error, '');
  }

  if (prototype.css) Pagelet.prototype.css = path.resolve(dir, prototype.css);
  if (prototype.js) Pagelet.prototype.js = path.resolve(dir, prototype.js);

  //
  // Make sure that all our dependencies are also directly mapped to an
  // absolute URL.
  //
  if (prototype.dependencies) {
    Pagelet.prototype.dependencies = prototype.dependencies.map(function each(dep) {
      if (/^(http:|https:)?\/\//.test(dep)) return dep;
      return path.resolve(dir, dep);
    });
  }

  //
  // Aliasing, some methods can be written with different names or American
  // vs Britain vs old English. For example `initialise` vs `initialize` but
  // also the use of CAPS like `RPC` vs `rpc`
  //
  if (Array.isArray(prototype.rpc) && !prototype.RPC.length) {
    Pagelet.prototype.RPC = prototype.rpc;
  }

  if ('function' === typeof prototype.initialise) {
    Pagelet.prototype.initialize = prototype.initialise;
  }

  //
  // Allow plugins to hook in the transformation process, so emit it when
  // all our transformations are done and before we create a copy of the
  // "fixed" properties which later can be re-used again to restore
  // a generated instance to it's original state.
  //
  if ('function' === typeof hook) hook(Pagelet);
  Pagelet.properties = Object.keys(Pagelet.prototype);

  //
  // Setup a FreeList for the pagelets so we can re-use the pagelet
  // instances and reduce garbage collection.
  //
  Pagelet.freelist = new FreeList('pagelet', Pagelet.prototype.freelist || 1000, function allocate() {
    return new Pagelet;
  });

  return Pagelet;
};

//
// Expose the pagelet.
//
module.exports = Pagelet;