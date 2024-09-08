#include "modules/sim/simulation.h"

#include <cstddef>
#include <string>
#include <string_view>

#include "error.h"
#include "lib/openmp/nbody_cpu.h"
#include "modules/scenarios/scenarios.h"
#include "modules/sim/collisions.h"

namespace grav {

void cuda_step(Simulation& sim);
void cuda_download_positions(Simulation& sim);

void sync_positions(Simulation& sim) {
    if (sim.positions_on_device) {
        cuda_download_positions(sim);
    }
}

void step(Simulation& sim) {
    switch (active_backend(sim)) {
    case Backend::Cpu:
        sync_positions(sim);
        sim.positions_on_device = false;
        cpu_step(sim.particles, sim.params);
        if (sim.params.merge_on_collision && sim.params.force_model != ForceModel::Sph) {
            merge_collisions(sim.particles, sim.params.merge_radius);
        }
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
    } else if (scenario_name == "fluid_block") {
        scenarios::fluid_block(sim.particles, count);
    } else {
        throw AppError::not_found(std::string("scenario: ") + std::string(scenario_name));
    }
    sim.positions_on_device = false;
}

}
