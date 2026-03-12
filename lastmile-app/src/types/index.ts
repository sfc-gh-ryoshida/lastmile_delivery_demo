export interface Package {
  package_id: string;
  depot_id: string;
  date: string;
  address: string;
  lat: number;
  lng: number;
  h3_index: string;
  time_window: string | null;
  weight: number;
  volume: number;
  is_redelivery: boolean;
  recipient_type: string;
  route_id: string | null;
  stop_order: number | null;
  driver_id?: string;
  driver_name?: string;
}

export interface Driver {
  driver_id: string;
  depot_id: string;
  name: string;
  vehicle_type: string;
  vehicle_capacity: number;
  vehicle_volume: number;
  skill_level: number;
  area_assignment: string | null;
  is_active: boolean;
}

export interface DriverLocation {
  driver_id: string;
  lat: number;
  lng: number;
  h3_index: string;
  speed: number;
  heading: number;
  timestamp: string;
}

export interface DeliveryStatus {
  package_id: string;
  driver_id: string | null;
  date: string;
  status: "pending" | "assigned" | "in_transit" | "delivered" | "absent" | "failed";
  completed_at: string | null;
  is_absent: boolean;
  attempt_count: number;
}

export interface DriverProgress {
  driver_id: string;
  name: string;
  total_packages: number;
  delivered: number;
  absent: number;
  in_transit: number;
  progress_pct: number;
  current_lat: number | null;
  current_lng: number | null;
  current_speed: number | null;
}

export interface RiskScore {
  H3_INDEX: string;
  DATE: string;
  HOUR: number;
  RISK_SCORE: number;
  RISK_FACTORS: Record<string, unknown>;
}

export interface AbsencePattern {
  H3_INDEX: string;
  DAY_OF_WEEK: number;
  HOUR: number;
  ABSENCE_RATE: number;
  SAMPLE_COUNT: number;
}

export interface WeatherForecast {
  H3_INDEX: string;
  DATETIME: string;
  PRECIPITATION: number;
  WIND_SPEED: number;
  TEMPERATURE: number;
  WEATHER_CODE: string;
}

export interface KpiDaily {
  DATE: string;
  DEPOT_ID: string;
  TOTAL_PACKAGES: number;
  DELIVERED: number;
  ABSENT: number;
  COMPLETION_RATE: number;
  ABSENCE_RATE: number;
  ONTIME_RATE: number;
  AVG_DELIVERY_TIME: number;
}

export interface AnomalyAlert {
  ALERT_ID: string;
  DRIVER_ID: string;
  DRIVER_NAME: string;
  DATE: string;
  HOUR: number;
  ANOMALY_SCORE: number;
  EXPECTED_PACE: number;
  ACTUAL_PACE: number;
  SEVERITY: "critical" | "warning" | "info";
  ALERT_TYPE: string;
  DESCRIPTION: string;
  RECOMMENDED_ACTION: string;
}

export interface DemandForecast {
  DEPOT_ID: string;
  DATE: string;
  FORECAST_VOLUME: number;
  CONFIDENCE_LOWER: number;
  CONFIDENCE_UPPER: number;
}

export interface TrafficRealtime {
  h3_index: string;
  datetime: string;
  congestion_level: number;
  speed_ratio: number;
}

export interface RoadConstruction {
  construction_id: number;
  h3_index: string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
  start_date: string;
  end_date: string | null;
  restriction_type: string;
  description: string;
}

export interface Route {
  route_id: string;
  driver_id: string;
  depot_id: string;
  date: string;
  total_distance: number;
  total_time_est: number;
  stop_count: number;
  status: string;
}

export interface Depot {
  depot_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}
