# Homebrew formula for CozyTerm
# To create a tap: gh repo create engindearing-projects/homebrew-tap --public
# Then copy this file to Formula/cozyterm.rb in that repo
#
# Users install with:
#   brew tap engindearing/tap
#   brew install cozyterm
# Or shorthand:
#   brew install engindearing/tap/cozyterm

class Cozyterm < Formula
  desc "AI coding agent for the terminal — gets better the more you use it"
  homepage "https://cozyterm.com"
  url "https://github.com/engindearing-projects/cozyterm.git",
      branch: "v2-rewrite"
  version "2.0.0"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    system "bun", "install", "--frozen-lockfile"

    # Install the full source tree
    libexec.install Dir["*"]
    libexec.install ".cozyterm" if File.directory?(".cozyterm")

    # Create a wrapper script
    (bin/"cozy").write <<~EOS
      #!/usr/bin/env bash
      exec bun run "#{libexec}/bin/cozy.ts" "$@"
    EOS
  end

  def post_install
    # Create user config directories
    (var/"cozyterm").mkpath
    ohai "CozyTerm installed. Run 'cozy' to start."
    ohai "For local models, install Ollama: https://ollama.com"
  end

  def caveats
    <<~EOS
      CozyTerm uses Ollama for local AI models (optional but recommended).
      Install Ollama from https://ollama.com, then pull models:

        ollama pull qwen2.5:7b-instruct   # orchestrator (tool calling)
        ollama pull llama3.2               # chat

      Start coding:
        cozy                    # interactive TUI
        cozy "fix the bug"      # one-shot mode
        cozy --plan             # read-only analysis
        cozy models             # check model availability

      Config: ~/.cozyterm/config.json
      Docs:   https://cozyterm.com
    EOS
  end

  test do
    assert_match "cozy", shell_output("#{bin}/cozy --version")
  end
end
