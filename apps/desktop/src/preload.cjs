const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mimexDesktop", {
  isDesktop: true,
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
