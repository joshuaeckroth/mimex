const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mimexDesktop", {
  isDesktop: true,
  clipboard: {
    writeText(text) {
      return ipcRenderer.invoke("mimex:clipboard:write-text", text);
    }
  },
  contextMenu: {
    show(payload) {
      return ipcRenderer.invoke("mimex:context-menu:show", payload);
    },
    onCommand(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      const wrapped = (_event, payload) => {
        listener(payload);
      };
      ipcRenderer.on("mimex:context-menu:command", wrapped);
      return () => {
        ipcRenderer.removeListener("mimex:context-menu:command", wrapped);
      };
    }
  },
  keychain: {
    getGitToken(tokenRef) {
      return ipcRenderer.invoke("mimex:keychain:get-token", tokenRef);
    },
    setGitToken(tokenRef, token) {
      return ipcRenderer.invoke("mimex:keychain:set-token", { tokenRef, token });
    },
    deleteGitToken(tokenRef) {
      return ipcRenderer.invoke("mimex:keychain:delete-token", tokenRef);
    }
  }
});
