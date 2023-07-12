#include "error.h"
#include "modules/sim/simulation.h"

namespace grav {

void cuda_step(Simulation&) {
    throw AppError::dependency_unavailable("cuda backend not built (BUILD_CUDA=OFF)");
}

}
