#include "modules/sim/simulation.h"

#include <cstddef>
#include <string>
#include <string_view>

#include "error.h"
#include "modules/scenarios/scenarios.h"

namespace grav {

void cpu_step(Particles& particles, const SimParams& params);
void cuda_step(Simulation& sim);

void step(Simulation& sim) {
    switch (sim.backend) {
    case Backend::Cpu:
        cpu_step(sim.particles, sim.params);
        return;
    case Backend::Cuda:
        cuda_step(sim);
        return;
    }
}

void reset(Simulation& sim, std::string_view scenario_name, std::size_t count) {
    if (scenario_name == "random_cluster") {
        scenarios::random_cluster(sim.particles, count);
    } else if (scenario_name == "solar_system") {
        scenarios::solar_system(sim.particles);
    } else if (scenario_name == "colliding_galaxies") {
        scenarios::colliding_galaxies(sim.particles, count / 2);
    } else {
        throw AppError::not_found(std::string("scenario: ") + std::string(scenario_name));
    }
}

}
