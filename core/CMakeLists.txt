add_library(error_lib STATIC
    src/error.cpp
)
target_include_directories(error_lib PUBLIC src)
