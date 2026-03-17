// Injects VWR interceptor at document_start so it patches fetch before the page makes API calls
(function () {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("vwr_interceptor.js");
  (document.head || document.documentElement).appendChild(script);
})();
