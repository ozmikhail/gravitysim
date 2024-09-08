#pragma once

#include <cstdint>

#include "modules/sim/integrator.h"

namespace grav {

enum class KernelVariant : std::uint8_t { Global, Tiled, Float4 };
enum class ForceModel : std::uint8_t { Direct, BarnesHut, Sph };
enum class Backend : std::uint8_t { Cpu, Cuda };

struct SimParams {
    float dt = 0.002F;
    float gravity = 1.0F;
    float softening = 0.08F;
    Integrator integrator = Integrator::Euler;
    KernelVariant kernel_variant = KernelVariant::Global;
    ForceModel force_model = ForceModel::Direct;
    float barnes_hut_theta = 0.6F;
    float sph_radius = 0.15F;
    float sph_rest_density = 1.0F;
    float sph_stiffness = 8.0F;
    float sph_viscosity = 0.01F;
    bool merge_on_collision = false;
    float merge_radius = 0.01F;
};

}
