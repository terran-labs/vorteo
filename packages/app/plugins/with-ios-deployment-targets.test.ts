import { describe, expect, it } from "vitest";

const { configureIOSDeploymentTargets } = require("./with-ios-deployment-targets");

describe("iOS pod deployment targets", () => {
  it("retains the React Native hook and applies the SDK57 deployment floor once", () => {
    const source =
      "  post_install do |installer|\n    react_native_post_install(\n      installer,\n    )\n  end";
    const configured = configureIOSDeploymentTargets(source);
    expect(configured).toContain("react_native_post_install(\n      installer,\n    )");
    expect(configured).toContain("podfile_properties['ios.deploymentTarget'] || '16.4'");
    expect(configured).toContain("Gem::Version.new('16.4')].max");
    expect(configureIOSDeploymentTargets(configured)).toBe(configured);
    expect(() => configureIOSDeploymentTargets("custom pod hook")).toThrow("post-install");
  });
  it("migrates the SDK54 marker block and retains higher explicit deployment targets", () => {
    const source =
      "    # Vorteo: align dependency deployment targets with the app\n    minimum = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')\n    installer.pods_project.targets.each do |target|\n    end";
    const configured = configureIOSDeploymentTargets(source);
    expect(configured).not.toContain("'15.1'");
    expect(configured).toContain(
      "minimum = [Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '16.4'), Gem::Version.new('16.4')].max",
    );
    expect(configured).toContain("installer.pods_project.targets.each do |target|");
    expect(configureIOSDeploymentTargets(configured)).toBe(configured);
    expect(() =>
      configureIOSDeploymentTargets(
        "# Vorteo: align dependency deployment targets with the app\ncustom minimum",
      ),
    ).toThrow("Unknown");
  });
});
