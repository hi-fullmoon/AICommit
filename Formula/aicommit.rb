class Aicommit < Formula
  desc "Safe, local-first AI commit message generator"
  homepage "https://github.com/hi-fullmoon/AICommit"
  url "https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-1.5.0.tgz"
  version "1.5.0"
  sha256 "76bdc2e4a366a71dfc6a8f15473e402b21e03a10dd74c3b6cf956f941851ef2d"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/aicommit"
  end

  test do
    ENV["HOME"] = testpath
    ENV["USERPROFILE"] = testpath
    assert_match "aicommit v#{version}", shell_output("#{bin}/aicommit --version")
    assert_match "Usage:", shell_output("#{bin}/aicommit --help")
    assert_match '"exitReason":"config_valid"', shell_output("#{bin}/aicommit config validate --output=json")
    assert_match "complete -c aicommit", shell_output("#{bin}/aicommit completion fish")
  end
end
