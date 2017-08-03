(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.RealmShim = factory());
}(this, (function () { 'use strict';

function createIframe() {
    var el = document.createElement("iframe");
    el.style.display = "none";
    // accessibility
    el.title = "script";
    el.setAttribute('aria-hidden', true);
    document.body.appendChild(el);
    return el;
}

function createSandbox(customGlobalObj, customThisValue) {
    var iframe = createIframe();
    var iframeDocument = iframe.contentDocument,
        confinedWindow = iframe.contentWindow;

    var globalObject = customGlobalObj || confinedWindow.Object.create(null);
    var thisValue = customThisValue || globalObject;
    return {
        iframe: iframe,
        iframeDocument: iframeDocument,
        confinedWindow: confinedWindow,
        thisValue: thisValue,
        globalObject: globalObject,
        globalProxy: undefined
    };
}

// locking down the environment
function sanitize(sandbox) {
    var o = sandbox.confinedWindow.Object;

    try {
        // Fixing properties of Object to comply with strict mode
        // and ES2016 semantics, we do this by redefining them while in 'use strict'
        // https://tc39.github.io/ecma262/#sec-object.prototype.__defineGetter__
        if (o === undefined) {
            return;
        }
        o.defineProperty(o.prototype, '__defineGetter__', {
            value: function value(key, fn) {
                return o.defineProperty(this, key, {
                    get: fn
                });
            }
        });
        o.defineProperty(o.prototype, '__defineSetter__', {
            value: function value(key, fn) {
                return o.defineProperty(this, key, {
                    set: fn
                });
            }
        });
        o.defineProperty(o.prototype, '__lookupGetter__', {
            value: function value(key) {
                var d,
                    p = this;
                while (p && (d = o.getOwnPropertyDescriptor(p, key)) === undefined) {
                    p = o.getPrototypeOf(this);
                }
                return d ? d.get : undefined;
            }
        });
        o.defineProperty(o.prototype, '__lookupSetter__', {
            value: function value(key) {
                var d,
                    p = this;
                while (p && (d = o.getOwnPropertyDescriptor(p, key)) === undefined) {
                    p = o.getPrototypeOf(this);
                }
                return d ? d.set : undefined;
            }
        });
        // Immutable Prototype Exotic Objects
        // https://github.com/tc39/ecma262/issues/272
        o.seal(o.prototype);
    } catch (ignore) {
        // Ignored
    }
}

// this flag allow us to determine if the eval() call is a controlled eval done by the realm's code
// or if it is user-land invocation, so we can react differently.
var isInternalEvaluation = false;

function setInternalEvaluation() {
    isInternalEvaluation = true;
}

function resetInternalEvaluation() {
    isInternalEvaluation = false;
}

var proxyHandler = {
    get: function get(sandbox, propName) {
        if (propName === 'eval' && isInternalEvaluation) {
            resetInternalEvaluation();
            return sandbox.confinedWindow.eval;
        }
        return sandbox.globalObject[propName];
    },
    set: function set(sandbox, propName, newValue) {
        sandbox.globalObject[propName] = newValue;
        return true;
    },
    defineProperty: function defineProperty(sandbox, propName, descriptor) {
        Object.defineProperty(sandbox.globalObject, propName, descriptor);
        return true;
    },
    deleteProperty: function deleteProperty(sandbox, propName) {
        return Reflect.deleteProperty(sandbox.globalObject, propName);
    },
    has: function has(sandbox, propName) {
        if (propName === 'eval' && isInternalEvaluation) {
            return true;
        }
        if (propName in sandbox.globalObject) {
            return true;
        } else if (propName in sandbox.confinedWindow) {
            throw new ReferenceError(propName + ' is not defined. If you are using typeof ' + propName + ', you can change your program to use typeof global.' + propName + ' instead');
        }
        return false;
    },
    ownKeys: function ownKeys(sandbox) {
        return Object.getOwnPropertyNames(sandbox.globalObject);
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(sandbox, propName) {
        return Object.getOwnPropertyDescriptor(sandbox.globalObject, propName);
    },
    isExtensible: function isExtensible(sandbox) {
        // TODO: can it becomes non-extensible?
        return true;
    },
    getPrototypeOf: function getPrototypeOf(sandbox) {
        return null;
    },
    setPrototypeOf: function setPrototypeOf(sandbox, prototype) {
        return prototype === null ? true : false;
    }
};

var HookFnName = '$RealmEvaluatorIIFE$';

// Wrapping the source with `with` statement creates a new lexical scope,
// that can prevent access to the globals in the sandbox by shadowing them
// via globalProxy.
function addLexicalScopesToSource(sourceText) {
    /**
     * We use a `with` statement who uses `argments[0]`, which is the
     * `sandbox.globalProxy` that implements the shadowing mechanism as well as access to
     * any global variable.
     * Aside from that, the `this` value in sourceText will correspond to `sandbox.thisValue`.
     * We have to use `arguments` instead of naming them to avoid name collision.
     */
    // escaping backsticks to prevent leaking the original eval as well as syntax errors
    sourceText = sourceText.replace(/\`/g, '\\`');
    return '\n        function ' + HookFnName + '() {\n            with(arguments[0]) {\n                return (function(){\n                    "use strict";\n                    return eval(`' + sourceText + '`);\n                }).call(this);\n            }\n        }\n    ';
}

function evalAndReturn(sourceText, sandbox) {
    var iframeDocument = sandbox.iframeDocument,
        confinedWindow = sandbox.confinedWindow;
    var iframeBody = iframeDocument.body;

    var script = iframeDocument.createElement('script');
    script.type = 'text/javascript';
    confinedWindow[HookFnName] = undefined;
    script.appendChild(iframeDocument.createTextNode(sourceText));
    iframeBody.appendChild(script);
    iframeBody.removeChild(script);
    var result = confinedWindow[HookFnName];
    confinedWindow[HookFnName] = undefined;
    return result;
}

function evaluate(sourceText, sandbox) {
    if (!sourceText) {
        return undefined;
    }
    sourceText = addLexicalScopesToSource(sourceText + '');
    setInternalEvaluation();
    var fn = evalAndReturn(sourceText, sandbox);
    var result = fn.apply(sandbox.thisValue, [sandbox.globalProxy]);
    resetInternalEvaluation();
    return result;
}

function getEvalEvaluator(sandbox) {
    var o = {
        // trick to set the name of the function to "eval"
        eval: function _eval(sourceText) {
            // console.log(`Shim-Evaluation: "${sourceText}"`);
            return evaluate(sourceText, sandbox);
        }
    };
    Object.setPrototypeOf(o.eval, sandbox.Function);
    o.eval.toString = function () {
        return 'function eval() { [shim code] }';
    };
    return o.eval;
}

function getFunctionEvaluator(sandbox) {
    var confinedWindow = sandbox.confinedWindow;

    var f = function Function() {
        for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
            args[_key] = arguments[_key];
        }

        // console.log(`Shim-Evaluation: Function("${args.join('", "')}")`);
        var sourceText = args.pop();
        var fnArgs = args.join(', ');
        return evaluate('(function anonymous(' + fnArgs + '){\n' + sourceText + '\n}).bind(this)', sandbox);
    };
    f.prototype = confinedWindow.Function.prototype;
    Object.setPrototypeOf(f, f.prototype);
    f.prototype.constructor = f;
    f.toString = function () {
        return 'function Function() { [shim code] }';
    };
    return f;
}

function getEvaluators(sandbox) {
    sandbox.Function = getFunctionEvaluator(sandbox);
    sandbox.eval = getEvalEvaluator(sandbox);
}

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var getProto = Object.getPrototypeOf;
var iteratorSymbol = (typeof Symbol === "undefined" ? "undefined" : _typeof(Symbol)) && Symbol.iterator || "@@iterator";

function getIntrinsics(sandbox) {
    var _ = sandbox.confinedWindow,
        globalObject = sandbox.globalObject;

    var anonymousArrayIteratorPrototype = getProto(_.Array(0)[iteratorSymbol]());
    var anonymousStringIteratorPrototype = getProto(_.String()[iteratorSymbol]());
    var anonymousIteratorPrototype = getProto(anonymousArrayIteratorPrototype);

    var strictArgumentsGenerator = _.eval('(function*(){"use strict";yield arguments;})');
    var anonymousGenerator = getProto(strictArgumentsGenerator);
    var anonymousGeneratorPrototype = getProto(anonymousGenerator);
    var anonymousGeneratorFunction = anonymousGeneratorPrototype.constructor;

    return {
        // %Array%
        "Array": _.Array,
        // %ArrayBuffer%
        "ArrayBuffer": _.ArrayBuffer,
        // %ArrayBufferPrototype%
        "ArrayBufferPrototype": _.ArrayBuffer.prototype,
        // %ArrayIteratorPrototype%
        "ArrayIteratorPrototype": anonymousArrayIteratorPrototype,
        // %ArrayPrototype%
        "ArrayPrototype": _.Array.prototype,
        // %ArrayProto_values%
        "ArrayProto_values": _.Array.prototype.values,
        // %Boolean%
        "Boolean": _.Boolean,
        // %BooleanPrototype%
        "BooleanPrototype": _.Boolean.prototype,
        // %DataView%
        "DataView": _.DataView,
        // %DataViewPrototype%
        "DataViewPrototype": _.DataView.prototype,
        // %Date%
        "Date": _.Date,
        // %DatePrototype%
        "DatePrototype": _.Date.prototype,
        // %decodeURI%
        "decodeURI": _.decodeURI,
        // %decodeURIComponent%
        "decodeURIComponent": _.decodeURIComponent,
        // %encodeURI%
        "encodeURI": _.encodeURI,
        // %encodeURIComponent%
        "encodeURIComponent": _.encodeURIComponent,
        // %Error%
        "Error": _.Error,
        // %ErrorPrototype%
        "ErrorPrototype": _.Error.prototype,
        // %eval%
        "eval": sandbox.eval,
        // %EvalError%
        "EvalError": _.EvalError,
        // %EvalErrorPrototype%
        "EvalErrorPrototype": _.EvalError.prototype,
        // %Float32Array%
        "Float32Array": _.Float32Array,
        // %Float32ArrayPrototype%
        "Float32ArrayPrototype": _.Float32Array.prototype,
        // %Float64Array%
        "Float64Array": _.Float64Array,
        // %Float64ArrayPrototype%
        "Float64ArrayPrototype": _.Float64Array.prototype,
        // %Function%
        "Function": sandbox.Function,
        // %FunctionPrototype%
        "FunctionPrototype": _.Function.prototype,
        // %Generator%
        "Generator": anonymousGenerator,
        // %GeneratorFunction%
        "GeneratorFunction": anonymousGeneratorFunction,
        // %GeneratorPrototype%
        "GeneratorPrototype": anonymousGeneratorPrototype,
        // %Int8Array%
        "Int8Array": _.Int8Array,
        // %Int8ArrayPrototype%
        "Int8ArrayPrototype": _.Int8Array.prototype,
        // %Int16Array%
        "Int16Array": _.Int16Array,
        // %Int16ArrayPrototype%,
        "Int16ArrayPrototype": _.Int16Array.prototype,
        // %Int32Array%
        "Int32Array": _.Int32Array,
        // %Int32ArrayPrototype%
        "Int32ArrayPrototype": _.Int32Array.prototype,
        // %isFinite%
        "isFinite": _.isFinite,
        // %isNaN%
        "isNaN": _.isNaN,
        // %IteratorPrototype%
        "IteratorPrototype": anonymousIteratorPrototype,
        // %JSON%
        "JSON": _.JSON,
        // %Map%
        "Map": _.Map,
        // %MapIteratorPrototype%
        "MapIteratorPrototype": undefined,
        // %MapPrototype%
        "MapPrototype": _.Map.prototype,
        // %Math%
        "Math": _.Math,
        // %Number%
        "Number": _.Number,
        // %NumberPrototype%
        "NumberPrototype": _.Number.prototype,
        // %Object%
        "Object": _.Object,
        // %ObjectPrototype%
        "ObjectPrototype": _.Object.prototype,
        // %ObjProto_toString%
        "ObjProto_toString": _.Object.prototype.toString,
        // %ObjProto_valueOf%
        "ObjProto_valueOf": _.Object.prototype.valueOf,
        // %parseFloat%
        "parseFloat": _.parseFloat,
        // %parseInt%
        "parseInt": _.parseInt,
        // %Promise%
        "Promise": _.Promise,
        // %PromisePrototype%
        "PromisePrototype": _.Promise.prototype,
        // %Proxy%
        "Proxy": _.Proxy,
        // %RangeError%
        "RangeError": _.RangeError,
        // %RangeErrorPrototype%
        "RangeErrorPrototype": _.RangeError.prototype,
        // %ReferenceError%
        "ReferenceError": _.ReferenceError,
        // %ReferenceErrorPrototype%
        "ReferenceErrorPrototype": _.ReferenceError.prototype,
        // %Reflect%
        "Reflect": _.Reflect,
        // %RegExp%
        "RegExp": _.RegExp,
        // %RegExpPrototype%
        "RegExpPrototype": _.RegExp.prototype,
        // %Set%
        "Set": _.Set,
        // %SetIteratorPrototype%
        "SetIteratorPrototype": undefined,
        // %SetPrototype%
        "SetPrototype": _.Set.prototype,
        // %String%
        "String": _.String,
        // %StringIteratorPrototype%
        "StringIteratorPrototype": anonymousStringIteratorPrototype,
        // %StringPrototype%
        "StringPrototype": _.String.prototype,
        // %Symbol%
        "Symbol": _.Symbol,
        // %SymbolPrototype%
        "SymbolPrototype": _.Symbol.prototype,
        // %SyntaxError%
        "SyntaxError": _.SyntaxError,
        // %SyntaxErrorPrototype%
        "SyntaxErrorPrototype": _.SyntaxError.prototype,
        // %ThrowTypeError%
        "ThrowTypeError": undefined,
        // %TypedArray%
        "TypedArray": undefined,
        // %TypedArrayPrototype%
        "TypedArrayPrototype": undefined,
        // %TypeError%
        "TypeError": _.TypeError,
        // %TypeErrorPrototype%
        "TypeErrorPrototype": _.TypeError.prototype,
        // %Uint8Array%
        "Uint8Array": _.Uint8Array,
        // %Uint8ArrayPrototype%
        "Uint8ArrayPrototype": _.Uint8Array.prototype,
        // %Uint8ClampedArray%
        "Uint8ClampedArray": _.Uint8ClampedArray,
        // %Uint8ClampedArrayPrototype%
        "Uint8ClampedArrayPrototype": _.Uint8ClampedArray.prototype,
        // %Uint16Array%
        "Uint16Array": _.Uint16Array,
        // %Uint16ArrayPrototype%
        "Uint16ArrayPrototype": Uint16Array.prototype,
        // %Uint32Array%
        "Uint32Array": _.Uint32Array,
        // %Uint32ArrayPrototype%
        "Uint32ArrayPrototype": _.Uint32Array.prototype,
        // %URIError%
        "URIError": _.URIError,
        // %URIErrorPrototype%
        "URIErrorPrototype": _.URIError.prototype,
        // %WeakMap%
        "WeakMap": _.WeakMap,
        // %WeakMapPrototype%
        "WeakMapPrototype": _.WeakMap.prototype,
        // %WeakSet%
        "WeakSet": _.WeakSet,
        // %WeakSetPrototype%
        "WeakSetPrototype": _.WeakSet.prototype,

        // TODO: Annex B
        // TODO: other special cases

        // ESNext
        global: globalObject,
        Realm: Realm
    };
}

function getStdLib(sandbox) {
    var intrinsics = getIntrinsics(sandbox);
    return {
        Array: { value: intrinsics.Array },
        ArrayBuffer: { value: intrinsics.ArrayBuffer },
        Boolean: { value: intrinsics.Boolean },
        DataView: { value: intrinsics.DataView },
        Date: { value: intrinsics.Date },
        decodeURI: { value: intrinsics.decodeURI },
        decodeURIComponent: { value: intrinsics.decodeURIComponent },
        encodeURI: { value: intrinsics.encodeURI },
        encodeURIComponent: { value: intrinsics.encodeURIComponent },
        Error: { value: intrinsics.Error },
        eval: { value: intrinsics.eval },
        EvalError: { value: intrinsics.EvalError },
        Float32Array: { value: intrinsics.Float32Array },
        Float64Array: { value: intrinsics.Float64Array },
        Function: { value: intrinsics.Function },
        Int8Array: { value: intrinsics.Int8Array },
        Int16Array: { value: intrinsics.Int16Array },
        Int32Array: { value: intrinsics.Int32Array },
        isFinite: { value: intrinsics.isFinite },
        isNaN: { value: intrinsics.isNaN },
        JSON: { value: intrinsics.JSON },
        Map: { value: intrinsics.Map },
        Math: { value: intrinsics.Math },
        Number: { value: intrinsics.Number },
        Object: { value: intrinsics.Object },
        parseFloat: { value: intrinsics.parseFloat },
        parseInt: { value: intrinsics.parseInt },
        Promise: { value: intrinsics.Promise },
        Proxy: { value: intrinsics.Proxy },
        RangeError: { value: intrinsics.RangeError },
        ReferenceError: { value: intrinsics.ReferenceError },
        Reflect: { value: intrinsics.Reflect },
        RegExp: { value: intrinsics.RegExp },
        Set: { value: intrinsics.Set },
        String: { value: intrinsics.String },
        Symbol: { value: intrinsics.Symbol },
        SyntaxError: { value: intrinsics.SyntaxError },
        TypeError: { value: intrinsics.TypeError },
        Uint8Array: { value: intrinsics.Uint8Array },
        Uint8ClampedArray: { value: intrinsics.Uint8ClampedArray },
        Uint16Array: { value: intrinsics.Uint16Array },
        Uint32Array: { value: intrinsics.Uint32Array },
        URIError: { value: intrinsics.URIError },
        WeakMap: { value: intrinsics.WeakMap },
        WeakSet: { value: intrinsics.WeakSet },

        // TODO: Annex B
        // TODO: other special cases

        // ESNext
        global: { value: intrinsics.global },
        Realm: { value: intrinsics.Realm }
    };
}

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var RealmToSandbox = new WeakMap();

function getSandbox(realm) {
    var sandbox = RealmToSandbox.get(realm);
    if (!sandbox) {
        throw new Error("Invalid realm object.");
    }
    return sandbox;
}

var Realm = function () {
    function Realm() {
        var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

        _classCallCheck(this, Realm);

        var thisValue = options.thisValue,
            globalObj = options.globalObj;

        var sandbox = createSandbox(globalObj, thisValue);
        sanitize(sandbox);
        Object.assign(sandbox, getEvaluators(sandbox));
        // TODO: assert that RealmToSandbox does not have `this` entry
        RealmToSandbox.set(this, sandbox);
        sandbox.globalProxy = new Proxy(sandbox, proxyHandler);
        this.init();
    }

    _createClass(Realm, [{
        key: "init",
        value: function init() {
            Object.defineProperties(this.global, this.stdlib);
        }
    }, {
        key: "eval",
        value: function _eval(sourceText) {
            var sandbox = getSandbox(this);
            return evaluate(sourceText, sandbox);
        }
    }, {
        key: "stdlib",
        get: function get() {
            var sandbox = getSandbox(this);
            return getStdLib(sandbox);
        }
    }, {
        key: "intrinsics",
        get: function get() {
            var sandbox = getSandbox(this);
            return getIntrinsics(sandbox);
        }
    }, {
        key: "global",
        get: function get() {
            var sandbox = getSandbox(this);
            return sandbox.globalObject;
        }
    }, {
        key: "thisValue",
        get: function get() {
            var sandbox = getSandbox(this);
            return sandbox.thisValue;
        }
    }]);

    return Realm;
}();

Realm.toString = function () {
    return 'function Realm() { [shim code] }';
};

return Realm;

})));
//# sourceMappingURL=realm-shim.js.map
