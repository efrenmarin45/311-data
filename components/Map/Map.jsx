/* eslint-disable */

import React from 'react';
import ReactDOM from 'react-dom';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import withStyles from '@mui/styles/withStyles';
import mapboxgl from 'mapbox-gl';
import FilterMenu from '@components/main/Desktop/FilterMenu';
import { REQUEST_TYPES } from '@components/common/CONSTANTS';
import { getNcByLngLat, clearPinInfo } from '@reducers/data';
import {
	updateNcId,
	updateSelectedCouncils,
	updateUnselectedCouncils,
} from '@reducers/filters';
import { closeBoundaries } from '@reducers/ui';
import {
	INITIAL_BOUNDS,
	INITIAL_LOCATION,
	GEO_FILTER_TYPES,
	MAP_STYLES,
} from './constants';

import {
	ccBoundaries,
	ncNameFromId,
	ccNameFromId,
	ncInfoFromLngLat,
} from './districts';

import { pointsWithinGeo, getNcByLngLatv2 } from './geoUtils';

import RequestsLayer from './layers/RequestsLayer';
import BoundaryLayer from './layers/BoundaryLayer';
import AddressLayer from './layers/AddressLayer';
import DbContext from '@db/DbContext';
import MapSearch from './controls/MapSearch';
import RequestDetail from './RequestDetail';
import { debounce, isEmpty } from '@utils';
import settings from '@settings';
import ZoomTooltip from './zoomTooltip';
import {
	DEFAULT_MIN_ZOOM,
	DEFAULT_MAX_ZOOM,
} from '@components/common/CONSTANTS';

const styles = (theme) => ({
  root: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '100%',
    margin: '0 auto',
    '& canvas.mapboxgl-canvas:focus': {
      outline: 'none',
    },
    '& .mapboxgl-control-container': {
      // TODO: update styles here when design finalized
    },
    '& .mapboxgl-popup-content': {
      width: 'auto',
      backgroundColor: theme.palette.primary.main,
      borderRadius: 5,
      padding: 10,
    },
    '& .mapboxgl-popup-close-button': {
      fontSize: 24,
      color: 'white',
      padding: 0,
      marginTop: 5,
      marginRight: 5,
    },
    '& .mapboxgl-popup': {
      maxWidth: '474px!important',
      '&-anchor-bottom .mapboxgl-popup-tip': {
        borderTopColor: theme.palette.primary.main,
      },
      '&-anchor-top .mapboxgl-popup-tip': {
        borderBottomColor: theme.palette.primary.main,
      },
      '&-anchor-left .mapboxgl-popup-tip': {
        borderRightColor: theme.palette.primary.main,
      },
      '&-anchor-right .mapboxgl-popup-tip': {
        borderLeftColor: theme.palette.primary.main,
      },
    },
  },
  loadedModal: {
   '& .mapboxgl-popup-content': {
      borderRadius: 30,
    },
  },
  menuWrapper: {
    position: 'absolute',
    left: '20px',
    top: '20px',
  },
});

// Define feature layers
const featureLayers = ['request-circles', 'nc-fills'];

class Map extends React.Component {
	// Note: 'this.context' is defined using the static contextType property
	// static contextType assignment allows Map to access values provided by DbContext.Provider
	static contextType = DbContext;
	constructor(props) {
		super(props);

		this.state = {
			mapReady: false,
			activeRequestsLayer: 'points',
			selectedTypes: props.selectedTypes,
			locationInfo: INITIAL_LOCATION,
			address: null,
			geoFilterType: GEO_FILTER_TYPES.address,
			filterGeo: null,
			filteredRequestCounts: {},
			hoveredRegionName: null,
			colorScheme: 'prism',
			mapStyle: 'light',
			canReset: true,
			selectedRequestId: null,
			selectedNc: null,
			requests: props.requests,
		};

		this.map = null;
		this.requestsLayer = null;
		this.addressLayer = null;
		this.ncLayer = null;
		this.ccLayer = null;
		this.requestDetail = null;
		this.popup = null;
		this.isSubscribed = null;
		this.initialState = props.initialState;
		this.hasSetInitialNCView = false;
	}

	componentDidMount() {
		this.isSubscribed = true;
		mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

		const map = new mapboxgl.Map({
			container: this.mapContainer,
			style: MAP_STYLES[this.state.mapStyle],
			bounds: INITIAL_BOUNDS,
			fitBoundsOptions: { padding: 50 },
			pitchWithRotate: false,
			dragRotate: false,
			touchZoomRotate: false,
			minZoom: DEFAULT_MIN_ZOOM,
			maxZoom: DEFAULT_MAX_ZOOM,
		});

		map.on('load', () => {
			if (this.isSubscribed) {
				this.initLayers(true);

				map.addControl(
					new mapboxgl.NavigationControl({
						visualizePitch: false,
						showCompass: false,
					}),
					'bottom-right'
				);

				map.on('click', this.debouncedOnClick);
				map.on('mouseenter', 'request-circles', this.onMouseEnter);
				map.on('mouseleave', 'request-circles', this.onMouseLeave);

				map.once('idle', (e) => {
					this.setState({ mapReady: true });
				});

        // Check to see if councilId is present and updates the state
				const {
					councilId,
					councils,
					dispatchUpdateNcId,
					dispatchUpdateSelectedCouncils,
					dispatchUpdateUnselectedCouncils,
				} = this.props;
				if (councilId) {
					const selectedCouncil = councils.find(
						({ councilId: id }) => id === councilId
					);
					if (selectedCouncil) {
						this.setState({ selectedNc: selectedCouncil });
						dispatchUpdateSelectedCouncils([selectedCouncil]);
						dispatchUpdateUnselectedCouncils(councils);
						dispatchUpdateNcId(councilId);
						this.ncLayer.selectRegion(councilId);
					}
				}
			}
		});
		this.map = map;
	}

	componentWillUnmount() {
		this.isSubscribed = false;
		this.map.remove();
	}

	componentDidUpdate(prevProps, prevState) {
		const entireMapLoadTime = () => {
			if (this.map.isSourceLoaded('requests')) {
				const { dbStartTime } = this.context;
				const pinLoadEndTime = performance.now();
				console.log(
					`Pin load time: ${Math.floor(pinLoadEndTime - dbStartTime)} ms`
				);
				this.map.off('idle', entireMapLoadTime);
			}
		};

    if (this.props.requests != prevProps.requests) {
      if (this.state.mapReady) {
        this.setState({ requests: this.props.requests });
        this.map.on('idle', entireMapLoadTime);
      } else {
        this.map.once('idle', () => {
          this.setState({ requests: this.props.requests });
        });
      }
    }

    this.map.on('load', () => {
      // grab the Zoom Out button of the Mapbox zoom controls
      const zoomOutControl = document.querySelector(
        '.mapboxgl-ctrl-zoom-out'
      );

			// use state to control tooltip's visibility
			let showZoomTooltip = false;

			// if zoom controls aren't limited, add the 'Zoom out' title back
			if (!showZoomTooltip) {
				zoomOutControl.title = 'Zoom out';
			}

			// render the zoomtooltip component
			const renderZoomTooltip = () => {
				ReactDOM.render(<ZoomTooltip show={showZoomTooltip} />, zoomOutControl);
			};

			// show the zoomtooltip on hover if the map is locked onto an ncLayer AND
			// the zoom out control is disabled
			const handleMouseEnter = () => {
				// check if the current zoom level (this.map.getZoom()) is at or below minZoom,
				// indicating the map is zoomed in to its minimum level & the zoom out control is disabled
				const isZoomOutDisabled = this.map.getZoom() <= this.state.minZoom;
				if (this.state.filterGeo && isZoomOutDisabled) {
					showZoomTooltip = true;
					renderZoomTooltip();
				}
			};

			// hide the zoomtooltip on mouse leave
			const handleMouseLeave = () => {
				showZoomTooltip = false;
				renderZoomTooltip();
			};

			// add hover event listeners to the zoomOutControl
			zoomOutControl.addEventListener('mouseenter', handleMouseEnter);
			zoomOutControl.addEventListener('mouseleave', handleMouseLeave);

			if (
				this.state.filterGeo !== prevState.filterGeo ||
				this.state.selectedTypes !== prevState.selectedTypes
			)
				this.map.once('idle', this.setFilteredRequestCounts);

			if (this.props.ncBoundaries != prevProps.ncBoundaries) {
				this.ncLayer.init({
					map: this.map,
					addListeners: true,
					sourceId: 'nc',
					sourceData: this.props.ncBoundaries,
					idProperty: 'NC_ID',

					onSelectRegion: (geo) => {
						this.setState({
							locationInfo: {
								nc: {
									name: geo.properties.council_name,
									// url removed from /geojson payload
									// need to map from /councils response
									// url: geo.properties.waddress || geo.properties.dwebsite,
								},
							},
						});
						this.map.once('zoomend', () => {
							this.setState((prevState) => {
								const newMinZoom = this.map.getZoom();
								this.map.setMinZoom(newMinZoom);
								return {
									filterGeo: geo,
									minZoom: newMinZoom,
								};
							});

							// initial render
							renderZoomTooltip();
						});
					},
					onHoverRegion: (geo) => {
						this.setState({
							hoveredRegionName: geo
								? ncNameFromId(geo.properties.nc_id)
								: null,
						});
					},
				});
			}

			const {
				dispatchUpdateNcId,
				dispatchUpdateSelectedCouncils,
				dispatchUpdateUnselectedCouncils,
				councils,
				ncBoundaries,
			} = this.props;

			if (
				this.initialState.councilId &&
				!!councils?.length === true &&
				councils.length > 0 &&
				!this.hasSetInitialNCView &&
				ncBoundaries
			) {
				try {
					const selectedCouncilId = Number(this.initialState.councilId);
					const newSelectedCouncil = councils.find(
						({ councilId }) => councilId === selectedCouncilId
					);
					if (!newSelectedCouncil) {
						throw new Error('Council Does not exist from search query');
					}
					const newSelected = [newSelectedCouncil];
					dispatchUpdateSelectedCouncils(newSelected);
					dispatchUpdateUnselectedCouncils(councils);
					dispatchUpdateNcId(selectedCouncilId);
					this.hasSetInitialNCView = true;
				} catch (err) {
					console.error('could not set ncid');
					this.hasSetInitialNCView = false;
				}
			}
		});

		if (this.props.selectedNcId !== prevProps.selectedNcId) {
			const { councils, selectedNcId } = this.props;
			const nc = councils.find(({ councilId }) => councilId === selectedNcId);
			this.setState({ selectedNc: nc });
			return this.ncLayer.selectRegion(selectedNcId);
		}

		if (this.props.ncId !== prevProps.ncId) {
			const { councils, ncId } = this.props;
			const nc = councils.find(({ councilId }) => councilId === ncId);
			this.setState({ selectedNc: nc });
			return this.ncLayer.selectRegion(ncId);
		}
	}

	initLayers = (addListeners) => {
		this.addressLayer.init({
			map: this.map,
			addListeners,
			onSelectRegion: ({ geo, center }) =>
				this.setState({
					filterGeo: geo,
					...(center
						? {
								locationInfo: {
									location: `${center.lat.toFixed(6)} N ${center.lng.toFixed(
										6
									)} E`,
									radius: 1,
									nc: ncInfoFromLngLat(center),
								},
						  }
						: {}),
				}),
		});

		this.requestsLayer.init({
			map: this.map,
		});

		this.ccLayer.init({
			map: this.map,
			addListeners,
			sourceId: 'cc',
			sourceData: ccBoundaries,
			idProperty: 'name',
			onSelectRegion: (geo) => {
				this.setState({
					locationInfo: {
						cc: ccNameFromId(geo.properties.name),
					},
				});
				this.map.once('zoomend', () => {
					this.setState({ filterGeo: geo });
				});
			},
			onHoverRegion: (geo) => {
				this.setState({
					hoveredRegionName: geo ? ccNameFromId(geo.properties.name) : null,
				});
			},
		});
	};

  addPopup = (coordinates, requestId) => {
    this.setState({ selectedRequestId: requestId });
    this.popup = new mapboxgl.Popup({closeButton: false, anchor: 'left'})
      .setLngLat(coordinates)
      .setDOMContent(this.requestDetail)
      .addTo(this.map);
  };

	removePopup = () => {
		if (this.popup) {
			this.popup.remove();
			this.popup = null;
			this.setState({ selectedRequestId: null });
		}
	};

  reset = () => {
    const { dispatchUpdateNcId, dispatchUpdateSelectedCouncils } = this.props;

		this.zoomOut();
		this.addressLayer.clearMarker();
		this.ncLayer.clearSelectedRegion();
		this.ccLayer.clearSelectedRegion();
		this.removePopup();

		this.setState({
			locationInfo: INITIAL_LOCATION,
			address: null,
			canReset: false,
			selectedNc: null,
		});

		// Set councilId in reducers/filters back to null
		dispatchUpdateNcId(null);

		this.map.once('zoomend', () => {
			this.setState({
				filterGeo: null,
				canReset: true,
			});
		});

    // Reset MinZoom to original value after deselecting NC
    this.resetBoundaries();
    dispatchUpdateSelectedCouncils([])
    this.map.setMinZoom(DEFAULT_MIN_ZOOM);
  };

  resetBoundaries = () => {
    const {
      dispatchUpdateNcId,
    } = this.props;

    // Reset the selected NcId back to null.
    dispatchUpdateNcId(null);
  };

	addressSearchIsEmpty = () => {
		const addressSearchInput = document.querySelector('#geocoder input');
		return !Boolean(addressSearchInput?.value?.trim());
	};

	resetAddressSearch = () => {
		if (!this.addressSearchIsEmpty()) {
			// Dispatch custom event to MapSearch to trigger geocoder.clear() to clear Address Search input
			const geocoderElement = document.getElementById('geocoder');
			const resetEvent = new Event(settings.map.eventName.reset);
			geocoderElement.dispatchEvent(resetEvent);
		}
	};

	// returns an array of mapbox features at the specified point.
	getAllFeaturesAtPoint = (point) => {
		return this.map.queryRenderedFeatures(point, {
			layers: featureLayers,
		});
	};

	// returns true if a district has been selected on the map.
	hasDistrictSelected = () => !!this.state.selectedNc === true;

	/// EVENT HANDLERS ///
	onMouseEnter = (e) => {
		/* handle hover events */

		//get a list of all the map features
		const features = this.getAllFeaturesAtPoint(e.point);

		if (features.length === 0) {
			return;
		}

		//has a district already been selected? if so, proceed
		if (this.hasDistrictSelected()) {
			for (let i = 0; i < features.length; i += 1) {
				// Display pop-ups only for the current district
				if (
					features[i].properties.council_id &&
					this.props.selectedNcId !== features[i].properties.council_id
				) {
					return;
				}

				if (features[i].layer.id === 'request-circles') {
					const { coordinates } = features[i].geometry;
					const { requestId, typeId } = features[i].properties;
					this.addPopup(coordinates, requestId);
					return;
				}
			}
		}
	};

	onMouseLeave = (e) => {
		this.props.dispatchClearPinInfo();
		this.removePopup();
	};

	onClick = (e) => {
		/* handle click events */
		const {
			dispatchUpdateNcId,
			dispatchUpdateSelectedCouncils,
			dispatchUpdateUnselectedCouncils,
			dispatchCloseBoundaries,
			councils,
		} = this.props;

		const features = this.getAllFeaturesAtPoint(e.point);

    if (!features.length) {
      if(this.hasDistrictSelected()) {
        this.reset()
      }
    } else {
      for (let i = 0; i < features.length; i += 1) {
        const feature = features[i];
        if (feature.layer.id == 'nc-fills') {
          this.setState({ address: null });

					this.resetAddressSearch(); // Clear address search input
					dispatchCloseBoundaries(); // Collapse boundaries section

					const selectedCouncilId = Number(feature.properties.NC_ID);
					const newSelectedCouncil = councils.find(
						({ councilId }) => councilId === selectedCouncilId
					);
					const newSelected = isEmpty(newSelectedCouncil)
						? null
						: [newSelectedCouncil];

					dispatchUpdateSelectedCouncils(newSelected);
					dispatchUpdateUnselectedCouncils(councils);
					dispatchUpdateNcId(selectedCouncilId);

					return this.ncLayer.selectRegion(feature.id);
				} else {
					return null;
				}
			}
		}
	};

	debouncedOnClick = debounce(this.onClick);

	onChangeSearchTab = (tab) => {
		this.setState({ geoFilterType: tab });
		this.reset();
	};

	// Address Search event handler
	// An Address Search will triger the onGeocoderResult event
	onGeocoderResult = ({ result }) => {
		const {
			dispatchGetNcByLngLat,
			dispatchUpdateNcId,
			dispatchCloseBoundaries,
			dispatchUpdateSelectedCouncils,
			dispatchUpdateUnselectedCouncils,
			councils,
		} = this.props;

		// Reset boundaries input
		this.resetBoundaries();

		// Collapse boundaries section
		dispatchCloseBoundaries();

		// Reset map & zoom out
		this.reset();

		if (result.properties.type === GEO_FILTER_TYPES.nc) {
			this.setState({ address: null });
			dispatchUpdateNcId(result.id);
		} else {
			// When result.properties.type does not equal 'District'
			const [longitude, latitude] = result.center;
			const address = result.place_name.split(',').slice(0, -2).join(', ');

			const ncIdOfAddressSearch = getNcByLngLatv2({
				longitude,
				latitude,
			});
			if (!isEmpty(ncIdOfAddressSearch)) {
				//Adding name pill to search bar
				const newSelectedCouncil = councils.find(
					({ councilId }) => councilId === ncIdOfAddressSearch
				);
				if (!newSelectedCouncil) {
					throw new Error(
						'Council Id in address search geocoder result could not be found'
					);
				}
				const newSelected = [newSelectedCouncil];
				dispatchUpdateSelectedCouncils(newSelected);
				dispatchUpdateUnselectedCouncils(councils);

				dispatchUpdateNcId(Number(ncIdOfAddressSearch));
				this.setState({
					address: address,
				});

				// Add that cute House Icon on the map
				return this.addressLayer.addMarker([longitude, latitude]);
			} else {
				this.setState({
					address: address,
				});
				this.map.flyTo({
					center: [longitude, latitude],
					essential: true,
					zoom: 9,
				});
				return this.addressLayer.addMarker([longitude, latitude]);
			}
		}
	};

	zoomOut = () => {
		this.map.fitBounds(INITIAL_BOUNDS, { padding: 50, linear: true });
	};

  export = () => {
    console.log(this.map.getCanvas().toDataURL());
  };

	getDistrictCounts = (geoFilterType, filterGeo, selectedTypes) => {
		const { ncCounts, ccCounts } = this.props;
		const { counts, regionId } = (() => {
			switch (geoFilterType) {
				case GEO_FILTER_TYPES.nc:
					return {
						counts: ncCounts,
						regionId: filterGeo.properties.nc_id,
					};
				case GEO_FILTER_TYPES.cc:
					return {
						counts: ccCounts,
						regionId: filterGeo.properties.name,
					};
				default:
					return {};
			}
		})();

		return Object.keys(counts[regionId]).reduce((filteredCounts, rType) => {
			if (selectedTypes.includes(rType))
				filteredCounts[rType] = counts[regionId][rType];
			return filteredCounts;
		}, {});
	};

	setFilteredRequestCounts = () => {
		const { requests, filterGeo, geoFilterType, selectedTypes } = this.state;
		const { ncCounts, ccCounts } = this.props;

		// use pre-calculated values for nc and cc filters if available
		if (
			filterGeo &&
			((geoFilterType === GEO_FILTER_TYPES.nc && ncCounts) ||
				(geoFilterType === GEO_FILTER_TYPES.cc && ccCounts))
		)
			return this.setState({
				filteredRequestCounts: this.getDistrictCounts(
					geoFilterType,
					filterGeo,
					selectedTypes
				),
			});

		// otherwise, count up the filtered requests
		let filteredRequests = requests;

		// filter by type selection if necessary
		if (selectedTypes.length < Object.keys(REQUEST_TYPES).length)
			filteredRequests = {
				...filteredRequests,
				features: filteredRequests.features.filter((r) =>
					selectedTypes.includes(r.properties.type)
				),
			};

		// filter by geo if necessary
		if (filterGeo)
			filteredRequests = pointsWithinGeo(filteredRequests, filterGeo);

		// count up requests per type
		const counts = filteredRequests.features.reduce((p, c) => {
			const { type } = c.properties;
			p[type] = (p[type] || 0) + 1;
			return p;
		}, {});

    this.setState({ filteredRequestCounts: counts });
  };

  ncUpdateCheck () {
    //TODO: Holding off on this function until query parameter logic is implemented. 
    // Check to see if councilId is present and updates the state
    const {
      councilId,
      councils,
      dispatchUpdateNcId,
      dispatchUpdateSelectedCouncils,
      dispatchUpdateUnselectedCouncils,
    } = this.props;
    if (councilId) {
      const selectedCouncil = councils.find(
        ({ councilId: id }) => id === councilId
      );
      if (selectedCouncil) {
        this.setState({ selectedNc: selectedCouncil });
        dispatchUpdateSelectedCouncils([selectedCouncil]);
        dispatchUpdateUnselectedCouncils(councils);
        dispatchUpdateNcId(councilId);
        this.ncLayer.selectRegion(councilId);
      }
    }
  }
  setRequestDetailLoading = (isLoading) => {
    if (!isLoading && this.popup) {
      this.popup.addClassName(this.props.classes.loadedModal);
    }
  };

  //// RENDER ////

  render() {
    const {
      requestTypes,
      councils,
    } = this.props;

    const {
      geoFilterType,
      colorScheme,
      filterGeo,
      activeRequestsLayer,
      mapStyle,
      canReset,
      selectedRequestId,
      selectedTypes,
    } = this.state;

		const { classes } = this.props;

    return (
      <div
        className={classes.root}
        ref={(el) => (this.mapContainer = el)}
      >
        <RequestsLayer
          ref={(el) => (this.requestsLayer = el)}
          activeLayer={activeRequestsLayer}
          selectedTypes={selectedTypes}
          colorScheme={colorScheme}
          requestTypes={requestTypes}
        />
        <AddressLayer
          ref={(el) => (this.addressLayer = el)}
          // visible={geoFilterType === GEO_FILTER_TYPES.address}
          visible
          boundaryStyle={mapStyle === 'dark' ? 'light' : 'dark'}
        />
        <BoundaryLayer
          ref={(el) => (this.ncLayer = el)}
          // visible={geoFilterType === GEO_FILTER_TYPES.nc}
          visible
          boundaryStyle={mapStyle === 'dark' ? 'light' : 'dark'}
        />
        <BoundaryLayer
          ref={(el) => (this.ccLayer = el)}
          visible={geoFilterType === GEO_FILTER_TYPES.cc}
          boundaryStyle={mapStyle === 'dark' ? 'light' : 'dark'}
        />
        <div ref={(el) => (this.requestDetail = el)}>
          <RequestDetail 
            requestId={selectedRequestId} 
            loadingCallback={this.setRequestDetailLoading}
          />
        </div>
        {this.state.mapReady && requestTypes && (
          <>
            <div className={classes.menuWrapper}>
              <MapSearch
                map={this.map}
                geoFilterType={geoFilterType}
                councils={councils}
                onGeocoderResult={this.onGeocoderResult}
                onChangeTab={this.onChangeSearchTab}
                onReset={this.reset}
                canReset={!!filterGeo && canReset}
              />
              <FilterMenu
                resetMap={this.reset}
                resetAddressSearch={this.resetAddressSearch}
              />
            </div>
          </>
        )}
      </div>
    );
  }
}

Map.propTypes = {
	requests: PropTypes.shape({}),
	position: PropTypes.shape({}),
	selectedTypes: PropTypes.shape({}),
	dispatchGetNcByLngLat: PropTypes.func.isRequired,
	dispatchUpdateNcId: PropTypes.func.isRequired,
};

Map.defaultProps = {};

const mapStateToProps = (state) => ({
	ncBoundaries: state.metadata.ncGeojson,
	requestTypes: state.metadata.requestTypes,
	councils: state.metadata.councils,
	selectedNcId: state.filters.councilId,
	ncId: state.data.selectedNcId,
});

const mapDispatchToProps = (dispatch) => ({
	dispatchGetNcByLngLat: (coords) => dispatch(getNcByLngLat(coords)),
	dispatchUpdateNcId: (id) => dispatch(updateNcId(id)),
	dispatchUpdateSelectedCouncils: (councils) =>
		dispatch(updateSelectedCouncils(councils)),
	dispatchUpdateUnselectedCouncils: (councils) =>
		dispatch(updateUnselectedCouncils(councils)),
	dispatchCloseBoundaries: () => dispatch(closeBoundaries()),
	dispatchClearPinInfo: () => dispatch(clearPinInfo()),
});

// We need to specify forwardRef to allow refs on connected components.
// See https://github.com/reduxjs/react-redux/issues/1291#issuecomment-494185126
// for more info.
export default connect(mapStateToProps, mapDispatchToProps, null, {
	forwardRef: true,
})(withStyles(styles)(Map));
