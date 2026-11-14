// Evaluate in the inspected page realm. No filesystem or network operations here.
(() => {
  if (globalThis.__ticketXHR) throw new Error('An override helper already exists; remove it first');
  let undo = null;
  let matches = 0;
  const api = {
    install({ url, body }) {
      if (undo) throw new Error('Remove the active override first');
      const exact = new URL(url).href;
      const text = JSON.stringify(body);
      if (text === undefined) throw new Error('Supply a serializable JSON body');
      const fixture = JSON.parse(text);
      const proto = XMLHttpRequest.prototype;
      const keys = ['open', 'send', 'responseText', 'response'];
      const saved = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]));
      if (keys.some(key => !saved[key]?.configurable) || !saved.responseText.get || !saved.response.get)
        throw new Error('XHR descriptors cannot be safely patched');
      const requests = new WeakMap();
      const eligible = xhr => {
        const state = requests.get(xhr);
        if (!state?.sent || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300 ||
            !['', 'text', 'json'].includes(xhr.responseType)) return false;
        if (!state.counted) { state.counted = true; matches++; }
        return true;
      };
      const restore = () => { for (const key of keys) Object.defineProperty(proto, key, saved[key]); };
      matches = 0;
      try {
        Object.defineProperty(proto, 'open', { ...saved.open, value: function(method, requestUrl, ...rest) {
          requests.delete(this);
          const result = saved.open.value.call(this, method, requestUrl, ...rest);
          if (String(method).toUpperCase() === 'GET' && new URL(requestUrl, document.baseURI).href === exact)
            requests.set(this, { sent: false, counted: false });
          return result;
        }});
        Object.defineProperty(proto, 'send', { ...saved.send, value: function(...args) {
          const state = requests.get(this);
          if (state) state.sent = true;
          return saved.send.value.apply(this, args);
        }});
        Object.defineProperty(proto, 'responseText', { ...saved.responseText, get: function() {
          return eligible(this) && this.responseType !== 'json' ? text : saved.responseText.get.call(this);
        }});
        Object.defineProperty(proto, 'response', { ...saved.response, get: function() {
          return eligible(this) ? this.responseType === 'json' ? fixture : text : saved.response.get.call(this);
        }});
        undo = restore;
      } catch (error) { restore(); throw error; }
      return api.status();
    },
    status() { return { active: Boolean(undo), matched_responses: matches }; },
    remove() {
      if (undo) undo();
      undo = null;
      delete globalThis.__ticketXHR;
      return api.status();
    },
  };
  globalThis.__ticketXHR = api;
})();
