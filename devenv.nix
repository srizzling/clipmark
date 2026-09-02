{ pkgs, lib, config, inputs, ... }:

{
  packages = with pkgs; [
    git
    nodejs_22
    curl
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
  };

  env.NOTES_DIR = "${config.devenv.root}/.notes";
  env.PORT = "8102";

  scripts.dev.exec = ''
    set -euo pipefail
    mkdir -p "$NOTES_DIR"
    exec node --watch "$DEVENV_ROOT/src/server.js"
  '';

  scripts.test.exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT" && npm test
  '';

  enterShell = ''
    echo "clipmark -> dev (http://localhost:$PORT) | test"
  '';

  enterTest = ''
    cd "$DEVENV_ROOT" && npm test
  '';
}
