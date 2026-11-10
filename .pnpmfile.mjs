const buildToolPeers = {
  '@prisma/client@7.10.1': ['prisma', 'typescript'],
  '@nestjs/swagger@12.1.0': ['typescript'],
};

export const hooks = {
  readPackage(pkg) {
    // These peers are used by build tooling, which declares them separately.
    for (const name of buildToolPeers[`${pkg.name}@${pkg.version}`] ?? []) {
      if (pkg.peerDependenciesMeta?.[name]?.optional !== true) continue;
      delete pkg.peerDependencies[name];
      delete pkg.peerDependenciesMeta[name];
    }
    return pkg;
  },
};
