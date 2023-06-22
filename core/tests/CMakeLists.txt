add_executable(tests
    test_sim_step.cpp
    test_scenarios.cpp
    test_metrics.cpp
    test_integrator_energy.cpp
)

target_link_libraries(tests PRIVATE
    sim_lib
    scenarios_lib
    metrics_lib
    openmp_adapter
    cuda_stub_adapter
    Catch2::Catch2WithMain
)

target_compile_options(tests PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall;-Wextra;-Wpedantic>
)

set_target_properties(tests PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
)

include(Catch)
catch_discover_tests(tests)
