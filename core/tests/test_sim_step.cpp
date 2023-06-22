#include <catch2/catch_test_macros.hpp>

#include <cmath>

#include "error.h"
#include "modules/scenarios/scenarios.h"
#include "modules/sim/sim.h"

TEST_CASE("cpu step does not produce NaN positions", "[sim]") {
    grav::Simulation sim;
    sim.backend = grav::Backend::Cpu;
    sim.params.dt = 0.001F;
    sim.params.gravity = 1.0F;
    sim.params.softening = 0.05F;
    sim.params.integrator = grav::Integrator::Leapfrog;

    grav::scenarios::random_cluster(sim.particles, 64, 42);

    for (int i = 0; i < 100; ++i) {
        grav::step(sim);
    }

    for (const auto& p : sim.particles.positions) {
        REQUIRE(std::isfinite(p.x));
        REQUIRE(std::isfinite(p.y));
        REQUIRE(std::isfinite(p.z));
    }
}

TEST_CASE("reset to unknown scenario throws not_found", "[sim]") {
    grav::Simulation sim;
    REQUIRE_THROWS_AS(grav::reset(sim, "no_such_scenario", 64), AppError);
}

TEST_CASE("reset to random_cluster sizes particle arrays", "[sim]") {
    grav::Simulation sim;
    grav::reset(sim, "random_cluster", 256);
    REQUIRE(sim.particles.count() == 256);
    REQUIRE(sim.particles.positions.size() == 256);
    REQUIRE(sim.particles.velocities.size() == 256);
    REQUIRE(sim.particles.masses.size() == 256);
}
