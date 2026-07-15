// Minimal reproduction: CSInterface.evalScript("app.name", callback) returns
// the literal string "EvalScript error." on the affected host, even though
// app.name is a built-in ExtendScript global with no dependency on any
// custom script, extension code, or ScriptPath file.
var csInterface = new CSInterface();
var outputEl = document.getElementById("output");
var runBtn = document.getElementById("run");

runBtn.addEventListener("click", function () {
  outputEl.textContent = "running…";
  csInterface.evalScript("app.name", function (result) {
    outputEl.textContent =
      "raw callback: " + JSON.stringify(result) + "\n" +
      "typeof: " + typeof result + "\n" +
      'isEvalScriptError: ' + (result === "EvalScript error.");
  });
});
