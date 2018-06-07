// Adapted from SES/Caja
// Copyright (C) 2011 Google Inc.
// https://github.com/google/caja/blob/master/src/com/google/caja/ses/startSES.js
// https://github.com/google/caja/blob/master/src/com/google/caja/ses/repairES5.js

import { defineProperty, defineProperties, getPrototypeOf, setPrototypeOf } from './commons';

/**
 * The process to repair constructors:
 * 1. Obtain the prototype from an instance
 * 2. Create a substitute noop constructor
 * 3. Replace its prototype property with the original prototype
 * 4. Replace its prototype property's constructor with itself
 * 5. Replace its [[Prototype]] slot with the noop constructor of Function
 */
function repairFunction(contextRec, functionName, functionDecl) {
  const { contextEval, contextFunction, contextGlobal } = contextRec;

  let FunctionInstance;
  try {
    FunctionInstance = contextEval(`(${functionDecl}(){})`);
  } catch (e) {
    if (!(e instanceof contextGlobal.SyntaxError)) {
      // Re-throw
      throw e;
    }
    // Prevent failure on platforms where generators are not supported.
    return;
  }
  const FunctionPrototype = getPrototypeOf(FunctionInstance);

  // Block evaluation of source when calling constructor on the prototype of functions.
  const TamedFunction = contextFunction('throw new Error("Not available");');

  defineProperties(TamedFunction, {
    name: {
      value: functionName
    },
    prototype: {
      value: FunctionPrototype
    }
  });
  defineProperty(FunctionPrototype, 'constructor', { value: TamedFunction });

  // Ensures that all functions meet "instanceof Function" in a realm.
  setPrototypeOf(TamedFunction, contextFunction.prototype.constructor);
}

/**
 * This block replaces the original Function constructor, and the original
 * %GeneratorFunction% %AsyncFunction% and %AsyncGeneratorFunction%, with
 * safe replacements that preserve SES confinement. After this block is done,
 * the originals should no longer be reachable.
 */
export function repairFunctions(contextRec) {
  // Here, the order of operation is important: Function needs to be
  // repaired first since the other constructors need it.
  repairFunction(contextRec, 'Function', 'function');
  repairFunction(contextRec, 'GeneratorFunction', 'function*');
  repairFunction(contextRec, 'AsyncFunction', 'async function');
  repairFunction(contextRec, 'AsyncGeneratorFunction', 'async function*');
}
