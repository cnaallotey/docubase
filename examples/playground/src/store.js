import { randomUUID } from 'node:crypto';

/** An in-memory task list. Everything is lost when the process stops. */
export function createStore() {
  const tasks = new Map();

  function listTasks({ done } = {}) {
    const all = [...tasks.values()];
    if (done === undefined) return all;
    return all.filter((task) => task.done === done);
  }

  function getTask(id) {
    return tasks.get(id) ?? null;
  }

  function addTask({ title, done = false }) {
    if (typeof title !== 'string' || !title.trim()) throw new TypeError('title must be a non-empty string');
    const task = { id: randomUUID(), title: title.trim(), done: Boolean(done), createdAt: new Date().toISOString() };
    tasks.set(task.id, task);
    return task;
  }

  function updateTask(id, changes) {
    const task = tasks.get(id);
    if (!task) return null;
    if (changes.title !== undefined) {
      if (typeof changes.title !== 'string' || !changes.title.trim()) throw new TypeError('title must be a non-empty string');
      task.title = changes.title.trim();
    }
    if (changes.done !== undefined) task.done = Boolean(changes.done);
    return task;
  }

  function removeTask(id) {
    return tasks.delete(id);
  }

  return { listTasks, getTask, addTask, updateTask, removeTask };
}

/** Put a few example tasks in the store. */
export function seedStore(store) {
  store.addTask({ title: 'Write the getting started page' });
  store.addTask({ title: 'Try the request playground', done: true });
  store.addTask({ title: 'Run docubase check' });
}
