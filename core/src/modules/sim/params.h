#pragma once

#include <cstdint>

#include "modules/sim/integrator.h"

namespace grav {

enum class KernelVariant : std::uint8_t { Global, Tiled, Float4 };
enum class Backend : std::uint8_t { Cpu, Cuda };

struct SimParams {
    float dt = 0.002F;
    float gravity = 1.0F;
    float softening = 0.08F;
    Integrator integrator = Integrator::Euler;
    KernelVariant kernel_variant = KernelVariant::Global;
    bool merge_on_collision = false;
    float merge_radius = 0.01F;
};

}
