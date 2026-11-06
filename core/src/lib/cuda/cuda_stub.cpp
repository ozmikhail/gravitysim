#include "error.h"
#include "lib/cuda/cuda_interop.h"
#include "modules/sim/simulation.h"

namespace grav {

void cuda_step(Simulation& sim) {
  static_cast<void>(&sim);
  throw AppError::dependency_unavailable("cuda backend not built (BUILD_CUDA=OFF)");
}

void cuda_download_positions(Simulation& sim) {
  static_cast<void>(&sim);
  throw AppError::dependency_unavailable("cuda backend not built (BUILD_CUDA=OFF)");
}

} // namespace grav
