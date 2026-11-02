const { withPodfile } = require("expo/config-plugins");

// Expo owns the scene runtime. Keep the fork's pod deployment floor independently.
function configureIOSDeploymentTargets(source) {
  const podMarker = "# Vorteo: align dependency deployment targets with the app";
  const minimum =
    "minimum = [Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '16.4'), Gem::Version.new('16.4')].max";
  if (source.includes(podMarker)) {
    const previousMinimum =
      /minimum = Gem::Version.new\(podfile_properties\['ios\.deploymentTarget'\] \|\| '(?:15\.1|16\.4)'\)/;
    if (source.includes(minimum)) return source;
    if (!previousMinimum.test(source)) throw new Error("Unknown Vorteo pod deployment-floor block");
    return source.replace(previousMinimum, minimum);
  }
  const postInstall = /    react_native_post_install\([\s\S]*?\n    \)/;
  if (!postInstall.test(source))
    throw new Error("Cannot locate React Native's pod post-install hook");
  return source.replace(
    postInstall,
    (call) => `${call}
    ${podMarker}
    ${minimum}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < minimum
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum.to_s
        end
      end
    end`,
  );
}

function withIOSDeploymentTargets(config) {
  return withPodfile(config, (mod) => {
    mod.modResults.contents = configureIOSDeploymentTargets(mod.modResults.contents);
    return mod;
  });
}

module.exports = withIOSDeploymentTargets;
module.exports.configureIOSDeploymentTargets = configureIOSDeploymentTargets;
