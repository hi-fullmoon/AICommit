class Aicommit < Formula
  desc "Safe, local-first AI commit message generator"
  homepage "https://github.com/hi-fullmoon/AICommit"
  url "https://registry.npmjs.org/@hifullmoon/aicommit/-/aicommit-1.4.0.tgz"
  version "1.4.0"
  sha256 "97d5a778337697021070e5976c355d0e110d0b5a12a2b9d9ce99a3bb7c649507"
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
