#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>

#include "modules/sim/params.h"
#include "modules/sim/particles.h"

namespace grav {

using BackendStateDeleter = void (*)(void*);
using BackendStatePtr = std::unique_ptr<void, BackendStateDeleter>;

inline BackendStatePtr empty_backend_state() {
    return {nullptr, +[](void*) {}};
}

struct Simulation {
    Backend backend = Backend::Cpu;
    Particles particles;
    SimParams params;
    BackendStatePtr backend_state = empty_backend_state();
    std::uint32_t output_vbo = 0;
};

void step(Simulation& sim);
void reset(Simulation& sim, std::string_view scenario_name, std::size_t count);

}
