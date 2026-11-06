#ifndef GRAV_MODULES_SIM_INTEGRATOR_H
#define GRAV_MODULES_SIM_INTEGRATOR_H

#include <cstdint>

namespace grav {

enum class Integrator : std::uint8_t { Euler, Leapfrog };

}

#endif // GRAV_MODULES_SIM_INTEGRATOR_H
