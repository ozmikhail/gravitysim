#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstddef>

#include "modules/sim/sim.h"

namespace {

float total_energy(const grav::Simulation& sim) {
    const auto& p = sim.particles;
    float kinetic = 0.0F;
    for (std::size_t i = 0; i < p.count(); ++i) {
        kinetic += 0.5F * p.masses[i] * grav::length_squared(p.velocities[i]);
    }

    const float eps2 = sim.params.softening * sim.params.softening;
    float potential = 0.0F;
    for (std::size_t i = 0; i < p.count(); ++i) {
        for (std::size_t j = i + 1; j < p.count(); ++j) {
            const grav::Vec3 d = p.positions[j] - p.positions[i];
            const float r = std::sqrt(grav::length_squared(d) + eps2);
            potential -= sim.params.gravity * p.masses[i] * p.masses[j] / r;
        }
    }
    return kinetic + potential;
}

float run_two_body(grav::Integrator integrator, int steps, float dt) {
    grav::Simulation sim;
    sim.backend = grav::Backend::Cpu;
    sim.params.dt = dt;
    sim.params.gravity = 1.0F;
    sim.params.softening = 0.001F;
    sim.params.integrator = integrator;

    sim.particles.resize(2);
    sim.particles.positions[0] = {0.0F, 0.0F, 0.0F};
    sim.particles.positions[1] = {0.4F, 0.0F, 0.0F};
    sim.particles.velocities[0] = {0.0F, 0.0F, 0.0F};
    sim.particles.velocities[1] = {0.0F, std::sqrt(1.0F / 0.4F), 0.0F};
    sim.particles.masses[0] = 1.0F;
    sim.particles.masses[1] = 0.001F;

    const float e0 = total_energy(sim);
    for (int i = 0; i < steps; ++i) {
        grav::step(sim);
    }
    const float e1 = total_energy(sim);
    return std::abs(e1 - e0) / std::abs(e0);
}

}

TEST_CASE("leapfrog drifts less than euler on a 2-body orbit", "[integrator]") {
    constexpr int steps = 4000;
    constexpr float dt = 0.005F;

    const float drift_euler = run_two_body(grav::Integrator::Euler, steps, dt);
    const float drift_leapfrog = run_two_body(grav::Integrator::Leapfrog, steps, dt);

    INFO("euler drift = " << drift_euler);
    INFO("leapfrog drift = " << drift_leapfrog);

    REQUIRE(drift_leapfrog < drift_euler);
}
