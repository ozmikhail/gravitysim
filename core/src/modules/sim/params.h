#ifndef GRAV_MODULES_SIM_PARAMS_H
#define GRAV_MODULES_SIM_PARAMS_H

#include "modules/sim/integrator.h"

#include <cstdint>

namespace grav {

enum class KernelVariant : std::uint8_t { Global, Tiled, Float4 };
enum class ForceModel : std::uint8_t { Direct, BarnesHut, Sph, Electrostatic };
enum class Backend : std::uint8_t { Cpu, Cuda };

inline constexpr float DEFAULT_DT = 0.002F;
inline constexpr float DEFAULT_SOFTENING = 0.08F;
inline constexpr float DEFAULT_BARNES_HUT_THETA = 0.6F;
inline constexpr float DEFAULT_SPH_RADIUS = 0.15F;
inline constexpr float DEFAULT_SPH_STIFFNESS = 8.0F;
inline constexpr float DEFAULT_SPH_VISCOSITY = 0.01F;
inline constexpr float DEFAULT_MERGE_RADIUS = 0.01F;

struct SimParams {
  float dt = DEFAULT_DT;
  float gravity = 1.0F;
  float softening = DEFAULT_SOFTENING;
  Integrator integrator = Integrator::Euler;
  KernelVariant kernel_variant = KernelVariant::Global;
  ForceModel force_model = ForceModel::Direct;
  float barnes_hut_theta = DEFAULT_BARNES_HUT_THETA;
  float sph_radius = DEFAULT_SPH_RADIUS;
  float sph_rest_density = 1.0F;
  float sph_stiffness = DEFAULT_SPH_STIFFNESS;
  float sph_viscosity = DEFAULT_SPH_VISCOSITY;
  float coulomb_strength = 1.0F;
  bool merge_on_collision = false;
  float merge_radius = DEFAULT_MERGE_RADIUS;
};

} // namespace grav

#endif // GRAV_MODULES_SIM_PARAMS_H
