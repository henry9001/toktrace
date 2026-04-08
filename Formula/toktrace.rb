class Toktrace < Formula
  desc "Zero-code LLM call tracing and cost tracking"
  homepage "https://github.com/henry9001/toktrace"
  url "https://registry.npmjs.org/toktrace/-/toktrace-0.1.0.tgz"
  sha256 "PLACEHOLDER_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/toktrace --version")

    # Verify init creates config directory
    system bin/"toktrace", "init"
    assert_predicate testpath/".toktrace/config.json", :exist?
  end
end
