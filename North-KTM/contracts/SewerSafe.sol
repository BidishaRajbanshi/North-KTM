// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SewerSafe — tamper-evident sewer safety records + robot-verified payment
/// @notice Two jobs in one contract:
///   1. RECORDS. Hazards, robot deployments, inspections and maintenance are written here as
///      compact events + a hash of the full report. Detailed data stays in the database; the
///      hash lets anyone prove the database record was not edited afterwards.
///   2. ESCROW. The municipality escrows payment for a sewer job. The contractor is paid ONLY
///      when an approved robot submits a signed proof that it did the job with no human
///      entering the manhole. A human entry is recorded permanently, the payment is refunded
///      and the contractor's bond is slashed to a worker welfare fund.
contract SewerSafe {
    // ------------------------------------------------------------------ types
    enum Status { None, Open, Proven, Disputed, Paid, HumanEntry, Refunded }

    struct Job {
        address contractor;
        bytes32 manholeId;     // keccak256 of the manhole's physical tag ID
        uint256 payment;       // escrowed MSTC (wei)
        uint64  minDuration;   // seconds the robot must operate inside
        uint64  deadline;      // unix time by which proof must arrive
        uint64  provenAt;      // when proof was accepted
        Status  status;
        address robot;         // device that did the work
        bytes32 evidenceHash;  // hash of the full evidence bundle (stored off-chain, e.g. IPFS)
        uint32  maxGasPpm;     // peak H2S reading reported (ppm) — shows how lethal the site was
    }

    struct Proof {
        uint256 jobId;
        bytes32 manholeId;
        bytes32 evidenceHash;
        uint64  startedAt;
        uint64  endedAt;
        bool    humanDetected;
        uint32  maxGasPpm;
    }

    // ------------------------------------------------------------------ state
    address public immutable municipality;
    address public welfareFund;
    uint64  public challengeWindow;   // seconds inspectors have to dispute a proof
    uint256 public requiredBond;      // MSTC a contractor must lock to take jobs

    mapping(address => address) public robotOwner;   // robot device address => contractor
    mapping(address => bool)    public inspectors;
    mapping(address => uint256) public bond;         // contractor => locked bond
    mapping(bytes32 => bool)    public usedEvidence; // replay protection
    mapping(uint256 => Job)     public jobs;
    uint256 public jobCount;

    uint256 public safeJobs;        // jobs completed with zero human entry
    uint256 public humanEntries;    // human entries caught by robots

    // ------------------------------------------------------------------ inspection records
    enum Risk { SAFE, WARNING, CRITICAL }
    enum RobotStatus { NONE, DEPLOYED, COMPLETED, FAILED, ABORTED }
    enum InspectionStatus { NONE, OPEN, COMPLETED, FAILED }
    enum MaintenanceStatus { NONE, NOT_REQUIRED, REQUIRED, COMPLETED }

    struct InspectionRecord {
        string  sewerId;
        uint64  createdAt;
        uint64  updatedAt;
        uint8   risk;               // Risk
        uint8   riskScore;          // 0..100
        uint8   robotStatus;        // RobotStatus
        uint8   inspectionStatus;   // InspectionStatus
        uint8   maintenanceStatus;  // MaintenanceStatus
        bytes32 reportHash;         // keccak256 of the full report kept in the database
        string  hazardSummary;      // short text, e.g. "HIGH_METHANE,LOW_OXYGEN"
        string  robotId;
        uint32  version;            // how many times this record was written
    }

    struct InspectionInput {
        bytes32 inspectionId;
        string  sewerId;
        uint8   risk;
        uint8   riskScore;
        string  hazardSummary;
        uint8   robotStatus;
        uint8   inspectionStatus;
        uint8   maintenanceStatus;
        bytes32 reportHash;
    }

    mapping(bytes32 => InspectionRecord) private _records;
    mapping(address => bool) public recorders;       // backend/city wallets allowed to write records
    uint256 public recordCount;

    // ------------------------------------------------------------------ events
    event RobotRegistered(address indexed robot, address indexed contractor);
    event RobotRevoked(address indexed robot);
    event BondDeposited(address indexed contractor, uint256 amount);
    event JobPosted(uint256 indexed jobId, address indexed contractor, bytes32 manholeId, uint256 payment);
    event ProofAccepted(uint256 indexed jobId, address indexed robot, bytes32 evidenceHash, uint32 maxGasPpm);
    event HumanEntryDetected(uint256 indexed jobId, address indexed robot, address indexed contractor, bytes32 evidenceHash, uint256 slashed);
    event Disputed(uint256 indexed jobId, address indexed inspector, string reason);
    event Paid(uint256 indexed jobId, address indexed contractor, uint256 amount);
    event Refunded(uint256 indexed jobId, uint256 amount);
    event RecorderSet(address indexed who, bool allowed);
    event HazardRecorded(bytes32 indexed inspectionId, string sewerId, uint8 risk, uint8 riskScore, string hazardSummary, bytes32 reportHash);
    event RobotDeploymentRecorded(bytes32 indexed inspectionId, string sewerId, string robotId);
    event InspectionRecorded(bytes32 indexed inspectionId, string sewerId, uint8 robotStatus, uint8 inspectionStatus, uint8 maintenanceStatus, bytes32 reportHash);
    event MaintenanceCompleted(bytes32 indexed inspectionId, string sewerId, bytes32 reportHash);

    // ------------------------------------------------------------------ errors
    error NotMunicipality();
    error NotInspector();
    error BadStatus();
    error BadSigner();
    error WrongManhole();
    error TooShort();
    error BadTimes();
    error Expired();
    error EvidenceReused();
    error InsufficientBond();
    error WindowOpen();
    error WindowClosed();
    error TransferFailed();
    error NotRecorder();
    error UnknownRecord();
    error BadValue();

    modifier onlyMunicipality() {
        if (msg.sender != municipality) revert NotMunicipality();
        _;
    }

    constructor(address _welfareFund, uint64 _challengeWindow, uint256 _requiredBond) {
        municipality = msg.sender;
        welfareFund = _welfareFund;
        challengeWindow = _challengeWindow;
        requiredBond = _requiredBond;
        inspectors[msg.sender] = true;
        recorders[msg.sender] = true;
    }

    // ------------------------------------------------------------------ admin
    function registerRobot(address robot, address contractor) external onlyMunicipality {
        robotOwner[robot] = contractor;
        emit RobotRegistered(robot, contractor);
    }

    function revokeRobot(address robot) external onlyMunicipality {
        delete robotOwner[robot];
        emit RobotRevoked(robot);
    }

    function setInspector(address who, bool ok) external onlyMunicipality {
        inspectors[who] = ok;
    }

    // ------------------------------------------------------------------ contractor
    function depositBond() external payable {
        bond[msg.sender] += msg.value;
        emit BondDeposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ jobs
    function postJob(address contractor, bytes32 manholeId, uint64 minDuration, uint64 deadline)
        external
        payable
        onlyMunicipality
        returns (uint256 jobId)
    {
        if (bond[contractor] < requiredBond) revert InsufficientBond();
        if (deadline <= block.timestamp) revert BadTimes();
        jobId = ++jobCount;
        Job storage j = jobs[jobId];
        j.contractor = contractor;
        j.manholeId = manholeId;
        j.payment = msg.value;
        j.minDuration = minDuration;
        j.deadline = deadline;
        j.status = Status.Open;
        emit JobPosted(jobId, contractor, manholeId, msg.value);
    }

    /// @notice Hash the robot signs (EIP-191 personal_sign over this digest).
    function proofDigest(Proof calldata p) public view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(this),
            p.jobId, p.manholeId, p.evidenceHash,
            p.startedAt, p.endedAt, p.humanDetected, p.maxGasPpm
        ));
    }

    /// @notice Anyone may relay the proof; what matters is that the ROBOT signed it.
    function submitProof(Proof calldata p, bytes calldata sig) external {
        Job storage j = jobs[p.jobId];
        if (j.status != Status.Open) revert BadStatus();
        if (block.timestamp > j.deadline) revert Expired();
        if (p.manholeId != j.manholeId) revert WrongManhole();
        if (p.endedAt <= p.startedAt || p.endedAt > block.timestamp + 300) revert BadTimes();
        if (usedEvidence[p.evidenceHash]) revert EvidenceReused();

        address robot = _recover(_ethSigned(proofDigest(p)), sig);
        if (robot == address(0) || robotOwner[robot] != j.contractor) revert BadSigner();

        usedEvidence[p.evidenceHash] = true;
        j.robot = robot;
        j.evidenceHash = p.evidenceHash;
        j.maxGasPpm = p.maxGasPpm;

        if (p.humanDetected) {
            // Permanent record. Payment back to the city, bond to the welfare fund.
            j.status = Status.HumanEntry;
            humanEntries++;
            uint256 slash = bond[j.contractor] < requiredBond ? bond[j.contractor] : requiredBond;
            bond[j.contractor] -= slash;
            uint256 refund = j.payment;
            j.payment = 0;
            emit HumanEntryDetected(p.jobId, robot, j.contractor, p.evidenceHash, slash);
            _send(welfareFund, slash);
            _send(municipality, refund);
            return;
        }

        if (p.endedAt - p.startedAt < j.minDuration) revert TooShort();
        j.status = Status.Proven;
        j.provenAt = uint64(block.timestamp);
        emit ProofAccepted(p.jobId, robot, p.evidenceHash, p.maxGasPpm);
    }

    /// @notice Inspectors can flag a suspicious proof (e.g. footage doesn't match the site).
    function dispute(uint256 jobId, string calldata reason) external {
        if (!inspectors[msg.sender]) revert NotInspector();
        Job storage j = jobs[jobId];
        if (j.status != Status.Proven) revert BadStatus();
        if (block.timestamp > j.provenAt + challengeWindow) revert WindowClosed();
        j.status = Status.Disputed;
        emit Disputed(jobId, msg.sender, reason);
    }

    /// @notice Municipality settles a dispute: pay the contractor, or refund the city.
    function resolve(uint256 jobId, bool payContractor) external onlyMunicipality {
        Job storage j = jobs[jobId];
        if (j.status != Status.Disputed) revert BadStatus();
        if (payContractor) _pay(jobId, j);
        else _refund(jobId, j);
    }

    /// @notice After the challenge window, anyone can trigger payment. No human sign-off needed.
    function release(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != Status.Proven) revert BadStatus();
        if (block.timestamp <= j.provenAt + challengeWindow) revert WindowOpen();
        _pay(jobId, j);
    }

    /// @notice No proof by the deadline → money goes back to the city.
    function reclaim(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open || block.timestamp <= j.deadline) revert BadStatus();
        _refund(jobId, j);
    }

    // ------------------------------------------------------------------ records
    modifier onlyRecorder() {
        if (!recorders[msg.sender]) revert NotRecorder();
        _;
    }

    function setRecorder(address who, bool allowed) external onlyMunicipality {
        recorders[who] = allowed;
        emit RecorderSet(who, allowed);
    }

    /// @notice A hazard was detected at a sewer. Opens (or updates) an inspection record.
    function recordHazard(bytes32 inspectionId, string calldata sewerId, uint8 risk, uint8 riskScore,
        string calldata hazardSummary, bytes32 reportHash) external onlyRecorder
    {
        if (risk > uint8(Risk.CRITICAL) || riskScore > 100 || bytes(sewerId).length == 0) revert BadValue();
        InspectionRecord storage r = _touch(inspectionId, sewerId);
        r.risk = risk;
        r.riskScore = riskScore;
        r.hazardSummary = hazardSummary;
        r.reportHash = reportHash;
        if (r.inspectionStatus == uint8(InspectionStatus.NONE)) r.inspectionStatus = uint8(InspectionStatus.OPEN);
        emit HazardRecorded(inspectionId, sewerId, risk, riskScore, hazardSummary, reportHash);
    }

    /// @notice A robot was sent in instead of a person.
    function recordRobotDeployment(bytes32 inspectionId, string calldata robotId) external onlyRecorder {
        InspectionRecord storage r = _existing(inspectionId);
        r.robotStatus = uint8(RobotStatus.DEPLOYED);
        r.robotId = robotId;
        emit RobotDeploymentRecorded(inspectionId, r.sewerId, robotId);
    }

    /// @notice Full inspection result (creates the record if it doesn't exist yet).
    function recordInspection(InspectionInput calldata i) external onlyRecorder {
        if (i.risk > uint8(Risk.CRITICAL) || i.riskScore > 100 || i.robotStatus > uint8(RobotStatus.ABORTED)
            || i.inspectionStatus > uint8(InspectionStatus.FAILED) || i.maintenanceStatus > uint8(MaintenanceStatus.COMPLETED)
            || bytes(i.sewerId).length == 0) revert BadValue();
        InspectionRecord storage r = _touch(i.inspectionId, i.sewerId);
        r.risk = i.risk;
        r.riskScore = i.riskScore;
        r.hazardSummary = i.hazardSummary;
        r.robotStatus = i.robotStatus;
        r.inspectionStatus = i.inspectionStatus;
        r.maintenanceStatus = i.maintenanceStatus;
        r.reportHash = i.reportHash;
        emit InspectionRecorded(i.inspectionId, i.sewerId, i.robotStatus, i.inspectionStatus, i.maintenanceStatus, i.reportHash);
    }

    /// @notice Maintenance found by the inspection has been done.
    function recordMaintenanceCompletion(bytes32 inspectionId, bytes32 reportHash) external onlyRecorder {
        InspectionRecord storage r = _existing(inspectionId);
        r.maintenanceStatus = uint8(MaintenanceStatus.COMPLETED);
        r.reportHash = reportHash;
        emit MaintenanceCompleted(inspectionId, r.sewerId, reportHash);
    }

    function getInspection(bytes32 inspectionId) external view returns (InspectionRecord memory) {
        if (_records[inspectionId].createdAt == 0) revert UnknownRecord();
        return _records[inspectionId];
    }

    function hasInspection(bytes32 inspectionId) external view returns (bool) {
        return _records[inspectionId].createdAt != 0;
    }

    function _touch(bytes32 id, string calldata sewerId) internal returns (InspectionRecord storage r) {
        r = _records[id];
        if (r.createdAt == 0) {
            r.createdAt = uint64(block.timestamp);
            r.sewerId = sewerId;
            recordCount++;
        } else if (keccak256(bytes(r.sewerId)) != keccak256(bytes(sewerId))) {
            revert BadValue();                    // an inspection can't move to another sewer
        }
        r.updatedAt = uint64(block.timestamp);
        r.version++;
    }

    function _existing(bytes32 id) internal returns (InspectionRecord storage r) {
        r = _records[id];
        if (r.createdAt == 0) revert UnknownRecord();
        r.updatedAt = uint64(block.timestamp);
        r.version++;
    }

    // ------------------------------------------------------------------ internal
    function _pay(uint256 jobId, Job storage j) internal {
        j.status = Status.Paid;
        uint256 amt = j.payment;
        j.payment = 0;
        safeJobs++;
        emit Paid(jobId, j.contractor, amt);
        _send(j.contractor, amt);
    }

    function _refund(uint256 jobId, Job storage j) internal {
        j.status = Status.Refunded;
        uint256 amt = j.payment;
        j.payment = 0;
        emit Refunded(jobId, amt);
        _send(municipality, amt);
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok, ) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    function _ethSigned(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        // reject malleable signatures (EIP-2)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(h, v, r, s);
    }

    receive() external payable { revert(); }
}
