class Aicommit < Formula
  desc "Safe, local-first AI commit message generator"
  homepage "https://github.com/hi-fullmoon/AICommit"
  url "https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-1.5.1.tgz"
  version "1.5.1"
  sha256 "64db7d3e8449f17db26d05bbe0f984c98299c89d51cbe3c4cbf52c9cc516479c"
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
