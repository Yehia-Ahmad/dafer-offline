// The signed-in user of the current request, for code that has no `req` (Mongoose plugins).
// requireAuth runs the rest of the request inside requestContext.run(...); async/await keeps it.
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

const runWithUser = (user, callback) => storage.run({ user }, callback);

/** { id, name } of the signed-in user, or null (auth off, or no request). */
const currentActor = () => {
  const store = storage.getStore();
  const user = store && store.user;
  return user ? { id: user._id, name: user.name } : null;
};

module.exports = { currentActor, runWithUser };
