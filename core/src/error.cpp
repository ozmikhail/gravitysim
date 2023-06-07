#include "error.h"

#include <string>
#include <string_view>

namespace {

constexpr std::string_view kInvalidInput = "invalid_input";
constexpr std::string_view kMissing = "missing";
constexpr std::string_view kStateConflict = "state_conflict";
constexpr std::string_view kDependencyUnavailable = "dependency_unavailable";
constexpr std::string_view kUnauthorized = "unauthorized";
constexpr std::string_view kNotFound = "not_found";
constexpr std::string_view kConflict = "conflict";
constexpr std::string_view kTimeout = "timeout";
constexpr std::string_view kUnimplemented = "unimplemented";
constexpr std::string_view kAccessDenied = "access_denied";

}

AppError::AppError(std::string_view kind, std::string_view message, Retry retry)
    : std::runtime_error(std::string(message)), kind_(kind), retry_(retry) {}

AppError AppError::invalid_input(std::string_view message) {
    return {kInvalidInput, message};
}

AppError AppError::missing(std::string_view message) {
    return {kMissing, message};
}

AppError AppError::state_conflict(std::string_view message) {
    return {kStateConflict, message};
}

AppError AppError::dependency_unavailable(std::string_view message) {
    return {kDependencyUnavailable, message, Retry::Yes};
}

AppError AppError::unauthorized(std::string_view message) {
    return {kUnauthorized, message};
}

AppError AppError::not_found(std::string_view message) {
    return {kNotFound, message};
}

AppError AppError::conflict(std::string_view message) {
    return {kConflict, message};
}

AppError AppError::timeout(std::string_view message) {
    return {kTimeout, message, Retry::Yes};
}

AppError AppError::unimplemented(std::string_view message) {
    return {kUnimplemented, message};
}

AppError AppError::access_denied(std::string_view message) {
    return {kAccessDenied, message};
}
